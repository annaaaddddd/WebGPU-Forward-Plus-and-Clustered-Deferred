import { Scene } from './stage/scene';
import { Lights } from './stage/lights';
import { Camera } from './stage/camera';
import { Stage } from './stage/stage';

export var canvas: HTMLCanvasElement;
export var canvasFormat: GPUTextureFormat;
export var context: GPUCanvasContext;
export var device: GPUDevice;
export var canvasTextureView: GPUTextureView;

export var aspectRatio: number;
export const fovYDegrees = 45;

// set by benchmark.ts, gets the frame time and the gpu time of each pass for every frame
export type PassTiming = { label: string, ms: number };
export let frameTimeListener: ((ms: number, passes: PassTiming[]) => void) | undefined;
export function setFrameTimeListener(listener: ((ms: number, passes: PassTiming[]) => void) | undefined) {
    frameTimeListener = listener;
}

// per-pass gpu timing with timestamp queries, does nothing if the feature isn't available
export const gpuTimer = {
    enabled: false,
    querySet: undefined as GPUQuerySet | undefined,
    resolveBuffer: undefined as GPUBuffer | undefined,
    stagingBuffer: undefined as GPUBuffer | undefined,
    labels: [] as string[],
    mapping: false,
    maxPasses: 8,

    init() {
        this.enabled = device.features.has('timestamp-query');
        if (!this.enabled) {
            console.log("timestamp-query not available, per-pass GPU timings are disabled");
            return;
        }
        const size = 2 * this.maxPasses * 8; // two u64 timestamps per pass
        this.querySet = device.createQuerySet({ label: "pass timestamps", type: 'timestamp', count: 2 * this.maxPasses });
        this.resolveBuffer = device.createBuffer({
            label: "pass timestamps resolve",
            size: size,
            usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC
        });
        this.stagingBuffer = device.createBuffer({
            label: "pass timestamps staging",
            size: size,
            usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST
        });
    },

    // called once per frame before draw()
    beginFrame() {
        this.labels = [];
    },

    // use as the `timestampWrites` of a render or compute pass descriptor
    pass(label: string): GPURenderPassTimestampWrites | undefined {
        if (!this.enabled || this.mapping || this.labels.length >= this.maxPasses) {
            return undefined;
        }
        const i = this.labels.length;
        this.labels.push(label);
        return { querySet: this.querySet!, beginningOfPassWriteIndex: 2 * i, endOfPassWriteIndex: 2 * i + 1 };
    },

    // call right before encoder.finish()
    resolve(encoder: GPUCommandEncoder) {
        if (!this.enabled || this.mapping || this.labels.length === 0) {
            return;
        }
        const n = 2 * this.labels.length;
        encoder.resolveQuerySet(this.querySet!, 0, n, this.resolveBuffer!, 0);
        encoder.copyBufferToBuffer(this.resolveBuffer!, 0, this.stagingBuffer!, 0, n * 8);
    },

    // call after the frame is done, returns the duration of each pass in ms
    async read(): Promise<PassTiming[]> {
        if (!this.enabled || this.mapping || this.labels.length === 0) {
            return [];
        }
        const labels = this.labels;
        const bytes = 2 * labels.length * 8;
        this.mapping = true;
        await this.stagingBuffer!.mapAsync(GPUMapMode.READ, 0, bytes);
        const t = new BigUint64Array(this.stagingBuffer!.getMappedRange(0, bytes));
        const result = labels.map((label, i) => ({ label, ms: Number(t[2 * i + 1] - t[2 * i]) / 1e6 }));
        this.stagingBuffer!.unmap();
        this.mapping = false;
        return result;
    }
};

export var modelBindGroupLayout: GPUBindGroupLayout;
export var materialBindGroupLayout: GPUBindGroupLayout;

// CHECKITOUT: this function initializes WebGPU and also creates some bind group layouts shared by all the renderers
export async function initWebGPU() {
    canvas = document.getElementById("mainCanvas") as HTMLCanvasElement;

    const devicePixelRatio = window.devicePixelRatio;
    canvas.width = canvas.clientWidth * devicePixelRatio;
    canvas.height = canvas.clientHeight * devicePixelRatio;

    aspectRatio = canvas.width / canvas.height;

    if (!navigator.gpu)
    {
        let errorMessageElement = document.createElement("h1");
        errorMessageElement.textContent = "This browser doesn't support WebGPU! Try using Google Chrome.";
        errorMessageElement.style.paddingLeft = '0.4em';
        document.body.innerHTML = '';
        document.body.appendChild(errorMessageElement);
        throw new Error("WebGPU not supported on this browser");
    }

    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter)
    {
        throw new Error("no appropriate GPUAdapter found");
    }

    // timestamp-query is only needed for the per-pass timings in the benchmark
    const requiredFeatures: GPUFeatureName[] = adapter.features.has('timestamp-query') ? ['timestamp-query'] : [];
    device = await adapter.requestDevice({ requiredFeatures });

    context = canvas.getContext("webgpu")!;
    canvasFormat = navigator.gpu.getPreferredCanvasFormat();
    context.configure({
        device: device,
        format: canvasFormat,
    });

    console.log("WebGPU init successsful");

    gpuTimer.init();

    modelBindGroupLayout = device.createBindGroupLayout({
        label: "model bind group layout",
        entries: [
            { // modelMat
                binding: 0,
                visibility: GPUShaderStage.VERTEX,
                buffer: { type: "uniform" }
            }
        ]
    });

    materialBindGroupLayout = device.createBindGroupLayout({
        label: "material bind group layout",
        entries: [
            { // diffuseTex
                binding: 0,
                visibility: GPUShaderStage.FRAGMENT,
                texture: {}
            },
            { // diffuseTexSampler
                binding: 1,
                visibility: GPUShaderStage.FRAGMENT,
                sampler: {}
            }
        ]
    });
}

export const vertexBufferLayout: GPUVertexBufferLayout = {
    arrayStride: 32,
    attributes: [
        { // pos
            format: "float32x3",
            offset: 0,
            shaderLocation: 0
        },
        { // nor
            format: "float32x3",
            offset: 12,
            shaderLocation: 1
        },
        { // uv
            format: "float32x2",
            offset: 24,
            shaderLocation: 2
        }
    ]
};

// per-renderer switches; each one adds or changes a pass and is off by default, so one class can
// serve several benchmark modes (e.g. 'forward+' and 'forward+ prepass') in the same session
export type RendererOptions = {
    prepass?: boolean   // Forward+: depth-only prepass, then shade only the visible surface
};

export abstract class Renderer {
    protected scene: Scene;
    protected lights: Lights;
    protected camera: Camera;
    protected options: RendererOptions;

    protected stats: Stats;

    private prevTime: number = 0;
    private frameRequestId: number;
    private stopped = false;

    constructor(stage: Stage, options: RendererOptions = {}) {
        this.scene = stage.scene;
        this.lights = stage.lights;
        this.camera = stage.camera;
        this.stats = stage.stats;
        this.options = options;

        this.frameRequestId = requestAnimationFrame((t) => this.onFrame(t));
    }

    stop(): void {
        this.stopped = true;
        cancelAnimationFrame(this.frameRequestId);
    }

    protected abstract draw(): void;

    // CHECKITOUT: this is the main rendering loop
    private onFrame(time: number) {
        if (this.prevTime == 0) {
            this.prevTime = time;
        }

        let deltaTime = time - this.prevTime;
        this.camera.onFrame(deltaTime);
        this.lights.onFrame(time);

        gpuTimer.beginFrame();

        if (frameTimeListener) {
            this.timedFrame(time);
            return;
        }

        this.stats.begin();

        this.draw();

        this.stats.end();

        this.prevTime = time;
        this.frameRequestId = requestAnimationFrame((t) => this.onFrame(t));
    }

    // benchmark path: one frame in flight, timed from submit until the gpu is done
    private async timedFrame(time: number) {
        // let the light movement compute pass finish first so it is not included in the measurement
        await device.queue.onSubmittedWorkDone();

        const start = performance.now();
        this.draw();
        await device.queue.onSubmittedWorkDone();
        const ms = performance.now() - start;
        const passes = await gpuTimer.read();
        frameTimeListener?.(ms, passes);

        this.prevTime = time;
        if (!this.stopped) {
            this.frameRequestId = requestAnimationFrame((t) => this.onFrame(t));
        }
    }
}
