import { vec3 } from "wgpu-matrix";
import { device, canvas, gpuTimer } from "../renderer";

import * as shaders from '../shaders/shaders';
import { Camera } from "./camera";

// h in [0, 1]
function hueToRgb(h: number) {
    let f = (n: number, k = (n + h * 6) % 6) => 1 - Math.max(Math.min(k, 4 - k, 1), 0);
    return vec3.lerp(vec3.create(1, 1, 1), vec3.create(f(5), f(3), f(1)), 0.8);
}

export class Lights {
    private camera: Camera;

    numLights = 500;
    static readonly maxNumLights = 5000;
    static readonly numFloatsPerLight = 8; // vec3f is aligned at 16 byte boundaries

    static readonly lightIntensity = 0.1;

    lightsArray = new Float32Array(Lights.maxNumLights * Lights.numFloatsPerLight);
    lightSetStorageBuffer: GPUBuffer;

    timeUniformBuffer: GPUBuffer;

    moveLightsComputeBindGroupLayout: GPUBindGroupLayout;
    moveLightsComputeBindGroup: GPUBindGroup;
    moveLightsComputePipeline: GPUComputePipeline;

    clusterSetStorageBuffer : GPUBuffer;

    clusterLightsComputeBindGroupLayout: GPUBindGroupLayout;
    clusterLightsComputeBindGroup: GPUBindGroup;
    clusterLightsComputePipeline: GPUComputePipeline;
    clusterLightsCullComputePipeline: GPUComputePipeline; // same shader, cullClusters = true

    // depth-based cluster culling: one u32 flag per cluster, set by the mark pass, cleared every frame
    clusterActiveBuffer: GPUBuffer;
    markClustersBindGroupLayout: GPUBindGroupLayout;
    markClustersComputePipeline: GPUComputePipeline;

    constructor(camera: Camera) {
        this.camera = camera;

        this.lightSetStorageBuffer = device.createBuffer({
            label: "lights",
            size: 16 + this.lightsArray.byteLength, // 16 for numLights + padding
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
        });
        this.populateLightsBuffer();
        this.updateLightSetUniformNumLights();

        this.timeUniformBuffer = device.createBuffer({
            label: "time uniform",
            size: 4,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
        });

        this.moveLightsComputeBindGroupLayout = device.createBindGroupLayout({
            label: "move lights compute bind group layout",
            entries: [
                { // lightSet
                    binding: 0,
                    visibility: GPUShaderStage.COMPUTE,
                    buffer: { type: "storage" }
                },
                { // time
                    binding: 1,
                    visibility: GPUShaderStage.COMPUTE,
                    buffer: { type: "uniform" }
                }
            ]
        });

        this.moveLightsComputeBindGroup = device.createBindGroup({
            label: "move lights compute bind group",
            layout: this.moveLightsComputeBindGroupLayout,
            entries: [
                {
                    binding: 0,
                    resource: { buffer: this.lightSetStorageBuffer }
                },
                {
                    binding: 1,
                    resource: { buffer: this.timeUniformBuffer }
                }
            ]
        });

        this.moveLightsComputePipeline = device.createComputePipeline({
            label: "move lights compute pipeline",
            layout: device.createPipelineLayout({
                label: "move lights compute pipeline layout",
                bindGroupLayouts: [ this.moveLightsComputeBindGroupLayout ]
            }),
            compute: {
                module: device.createShaderModule({
                    label: "move lights compute shader",
                    code: shaders.moveLightsComputeSrc
                }),
                entryPoint: "main"
            }
        });

        this.clusterSetStorageBuffer = device.createBuffer({
            label: "clusters",
            size: shaders.constants.numClusters * (1 + shaders.constants.maxLightsPerCluster) * 4,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC // COPY_SRC for clusterStats()
        });

        this.clusterActiveBuffer = device.createBuffer({
            label: "active clusters",
            size: shaders.constants.numClusters * 4,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC // COPY_DST: clearBuffer, COPY_SRC: clusterStats()
        });

        this.clusterLightsComputeBindGroupLayout = device.createBindGroupLayout({
            label: "cluster lights compute bind group layout",
            entries: [
                { // lightSet
                    binding: 0,
                    visibility: GPUShaderStage.COMPUTE,
                    buffer: { type: "read-only-storage" }
                },
                { // clusters
                    binding: 1,
                    visibility: GPUShaderStage.COMPUTE,
                    buffer: { type: "storage" }
                },
                { // camera uniform
                    binding: 2,
                    visibility: GPUShaderStage.COMPUTE,
                    buffer: { type: "uniform"}
                },
                { // active cluster flags
                    binding: 3,
                    visibility: GPUShaderStage.COMPUTE,
                    buffer: { type: "read-only-storage" }
                }
            ]
        });

        this.clusterLightsComputeBindGroup = device.createBindGroup({
            label: "cluster lights compute bind group",
            layout: this.clusterLightsComputeBindGroupLayout,
            entries: [
                {
                    binding: 0,
                    resource: { buffer: this.lightSetStorageBuffer }
                },
                {
                    binding: 1,
                    resource: { buffer: this.clusterSetStorageBuffer }
                },
                {
                    binding: 2,
                    resource: { buffer: camera.uniformsBuffer }
                },
                {
                    binding: 3,
                    resource: { buffer: this.clusterActiveBuffer }
                }
            ]
        });

        const clusteringModule = device.createShaderModule({
            label: "cluster lights compute shader",
            code: shaders.clusteringComputeSrc
        });
        const clusteringLayout = device.createPipelineLayout({
            label: "cluster lights compute pipeline layout",
            bindGroupLayouts: [ this.clusterLightsComputeBindGroupLayout ]
        });

        this.clusterLightsComputePipeline = device.createComputePipeline({
            label: "cluster lights compute pipeline",
            layout: clusteringLayout,
            compute: {
                module: clusteringModule,
                entryPoint: "main"
            }
        });

        // the culled variant sets the `override cullClusters` constant of the same shader
        this.clusterLightsCullComputePipeline = device.createComputePipeline({
            label: "cluster lights compute pipeline (culled)",
            layout: clusteringLayout,
            compute: {
                module: clusteringModule,
                entryPoint: "main",
                constants: { cullClusters: 1 }
            }
        });

        this.markClustersBindGroupLayout = device.createBindGroupLayout({
            label: "mark clusters bind group layout",
            entries: [
                { // camera uniform
                    binding: 0,
                    visibility: GPUShaderStage.COMPUTE,
                    buffer: { type: "uniform" }
                },
                { // depth buffer of the prepass / G-buffer pass
                    binding: 1,
                    visibility: GPUShaderStage.COMPUTE,
                    texture: { sampleType: "depth" }
                },
                { // active cluster flags
                    binding: 2,
                    visibility: GPUShaderStage.COMPUTE,
                    buffer: { type: "storage" }
                }
            ]
        });

        this.markClustersComputePipeline = device.createComputePipeline({
            label: "mark clusters compute pipeline",
            layout: device.createPipelineLayout({
                label: "mark clusters compute pipeline layout",
                bindGroupLayouts: [ this.markClustersBindGroupLayout ]
            }),
            compute: {
                module: device.createShaderModule({
                    label: "mark clusters compute shader",
                    code: shaders.markClustersComputeSrc
                }),
                entryPoint: "main"
            }
        });
    }

    // each culling renderer makes its own bind group for its depth texture
    createMarkClustersBindGroup(depthTextureView: GPUTextureView): GPUBindGroup {
        return device.createBindGroup({
            label: "mark clusters bind group",
            layout: this.markClustersBindGroupLayout,
            entries: [
                { binding: 0, resource: { buffer: this.camera.uniformsBuffer } },
                { binding: 1, resource: depthTextureView },
                { binding: 2, resource: { buffer: this.clusterActiveBuffer } }
            ]
        });
    }

    // clear the flags, then mark clusters from the depth buffer
    // run after the depth pass and before doLightClustering(encoder, true)
    markActiveClusters(encoder: GPUCommandEncoder, markBindGroup: GPUBindGroup) {
        encoder.clearBuffer(this.clusterActiveBuffer);

        const computePass = encoder.beginComputePass({
            label: "mark active clusters pass",
            timestampWrites: gpuTimer.pass("mark")
        });
        computePass.setPipeline(this.markClustersComputePipeline);
        computePass.setBindGroup(0, markBindGroup);
        computePass.dispatchWorkgroups(Math.ceil(canvas.width / 16), Math.ceil(canvas.height / 16));
        computePass.end();
    }

    private populateLightsBuffer() {
        for (let lightIdx = 0; lightIdx < Lights.maxNumLights; ++lightIdx) {
            // light pos is set by compute shader so no need to set it here
            const lightColor = vec3.scale(hueToRgb(Math.random()), Lights.lightIntensity);
            this.lightsArray.set(lightColor, (lightIdx * Lights.numFloatsPerLight) + 4);
        }

        device.queue.writeBuffer(this.lightSetStorageBuffer, 16, this.lightsArray);
    }

    updateLightSetUniformNumLights() {
        device.queue.writeBuffer(this.lightSetStorageBuffer, 0, new Uint32Array([this.numLights]));
    }

    // cull = true skips the clusters that markActiveClusters() left unmarked
    doLightClustering(encoder: GPUCommandEncoder, cull = false) {

        const computePass = encoder.beginComputePass({
            label: "light clustering pass",
            timestampWrites: gpuTimer.pass("clustering")
        });
        computePass.setPipeline(cull ? this.clusterLightsCullComputePipeline : this.clusterLightsComputePipeline);

        computePass.setBindGroup(0, this.clusterLightsComputeBindGroup);

        const workgroupCount = Math.ceil(shaders.constants.numClusters / shaders.constants.clusteringWorkgroupSize);
        computePass.dispatchWorkgroups(workgroupCount);

        computePass.end();
    }

    // CHECKITOUT: this is where the light movement compute shader is dispatched from the host
    onFrame(time: number) {
        device.queue.writeBuffer(this.timeUniformBuffer, 0, new Float32Array([time]));

        // not using same encoder as render pass so this doesn't interfere with measuring actual rendering performance
        const encoder = device.createCommandEncoder();

        const computePass = encoder.beginComputePass();
        computePass.setPipeline(this.moveLightsComputePipeline);

        computePass.setBindGroup(0, this.moveLightsComputeBindGroup);

        const workgroupCount = Math.ceil(this.numLights / shaders.constants.moveLightsWorkgroupSize);
        computePass.dispatchWorkgroups(workgroupCount);

        computePass.end();

        device.queue.submit([encoder.finish()]);
    }
}
