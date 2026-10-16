import * as renderer from '../renderer';
import * as shaders from '../shaders/shaders';
import { Stage } from '../stage/stage';

export class ForwardPlusRenderer extends renderer.Renderer {
    sceneUniformsBindGroupLayout: GPUBindGroupLayout;
    sceneUniformsBindGroup: GPUBindGroup;

    depthTexture: GPUTexture;
    depthTextureView: GPUTextureView;

    pipeline: GPURenderPipeline;

    // options.prepass: draw depth only first, then the main pass only shades fragments that match
    // that depth, so hidden surfaces don't run the lighting loop
    prepassPipeline: GPURenderPipeline | undefined;

    // options.cullClusters: after the prepass, mark the clusters behind visible pixels and only
    // cluster lights for those (needs the prepass depth, so it requires options.prepass)
    markClustersBindGroup: GPUBindGroup | undefined;

    constructor(stage: Stage, options: renderer.RendererOptions = {}) {
        super(stage, options);
        const prepass = options.prepass ?? false;
        if (options.cullClusters && !prepass) {
            throw new Error("cullClusters needs the depth prepass");
        }

        this.sceneUniformsBindGroupLayout = renderer.device.createBindGroupLayout({
            label: "scene uniforms bind group layout",
            entries: [
                { // camera
                    binding: 0,
                    visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
                    buffer: { type: "uniform" }
                },
                { // lightSet
                    binding: 1,
                    visibility: GPUShaderStage.FRAGMENT,
                    buffer: { type: "read-only-storage" }
                },
                { // cluster
                    binding: 2,
                    visibility: GPUShaderStage.FRAGMENT,
                    buffer: { type: "read-only-storage" }
                }
            ]
        });

        this.sceneUniformsBindGroup = renderer.device.createBindGroup({
            label: "scene uniforms bind group",
            layout: this.sceneUniformsBindGroupLayout,
            entries: [
                {
                    binding: 0,
                    resource: { buffer: this.camera.uniformsBuffer }
                },
                {
                    binding: 1,
                    resource: { buffer: this.lights.lightSetStorageBuffer }
                },
                {
                    binding: 2,
                    resource: { buffer: this.lights.clusterSetStorageBuffer }
                }
            ]
        });

        this.depthTexture = renderer.device.createTexture({
            size: [renderer.canvas.width, renderer.canvas.height],
            format: "depth24plus",
            // TEXTURE_BINDING so a later pass can read the prepass depth (cluster culling)
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING
        });
        this.depthTextureView = this.depthTexture.createView();

        if (options.cullClusters) {
            this.markClustersBindGroup = this.lights.createMarkClustersBindGroup(this.depthTextureView);
        }

        const pipelineLayout = renderer.device.createPipelineLayout({
            label: "forward plus pipeline layout",
            bindGroupLayouts: [
                this.sceneUniformsBindGroupLayout,
                renderer.modelBindGroupLayout,
                renderer.materialBindGroupLayout
            ]
        });

        if (prepass) {
            this.prepassPipeline = renderer.device.createRenderPipeline({
                label: "forward plus depth prepass pipeline",
                layout: pipelineLayout,
                depthStencil: {
                    depthWriteEnabled: true,
                    depthCompare: "less",
                    format: "depth24plus"
                },
                vertex: {
                    module: renderer.device.createShaderModule({
                        label: "forward plus depth prepass vert shader",
                        code: shaders.naiveVertSrc
                    }),
                    buffers: [ renderer.vertexBufferLayout ]
                },
                fragment: {
                    module: renderer.device.createShaderModule({
                        label: "forward plus depth prepass frag shader",
                        code: shaders.depthPrepassFragSrc,
                    }),
                    targets: [ ] // depth only, no color target
                }
            });
        }

        this.pipeline = renderer.device.createRenderPipeline({
            label: prepass ? "forward plus pipeline (after prepass)" : "forward plus pipeline",
            layout: pipelineLayout,
            depthStencil: prepass ? {
                depthWriteEnabled: false,
                depthCompare: "equal",
                format: "depth24plus"
            } : {
                depthWriteEnabled: true,
                depthCompare: "less",
                format: "depth24plus"
            },
            vertex: {
                module: renderer.device.createShaderModule({
                    label: "forward plus vert shader",
                    code: shaders.naiveVertSrc
                }),
                buffers: [ renderer.vertexBufferLayout ]
            },
            fragment: {
                module: renderer.device.createShaderModule({
                    label: "forward plus frag shader",
                    code: shaders.forwardPlusFragSrc,
                }),
                targets: [
                    {
                        format: renderer.canvasFormat,
                    }
                ]
            }
        });
    }

    // records the scene draw calls into a pass; used by the prepass and the main pass
    private drawScene(pass: GPURenderPassEncoder) {
        pass.setBindGroup(shaders.constants.bindGroup_scene, this.sceneUniformsBindGroup);

        this.scene.iterate(node => {
            pass.setBindGroup(shaders.constants.bindGroup_model, node.modelBindGroup);
        }, material => {
            pass.setBindGroup(shaders.constants.bindGroup_material, material.materialBindGroup);
        }, primitive => {
            pass.setVertexBuffer(0, primitive.vertexBuffer);
            pass.setIndexBuffer(primitive.indexBuffer, 'uint32');
            pass.drawIndexed(primitive.numIndices);
        });
    }

    override draw() {
        const encoder = renderer.device.createCommandEncoder();
        const canvasTextureView = renderer.context.getCurrentTexture().createView();

        if (!this.options.cullClusters) {
            this.lights.doLightClustering(encoder);
        }

        if (this.options.prepass) {
            const prepass = encoder.beginRenderPass({
                label: "forward plus depth prepass",
                timestampWrites: renderer.gpuTimer.pass("prepass"),
                colorAttachments: [ ],
                depthStencilAttachment: {
                    view: this.depthTextureView,
                    depthClearValue: 1.0,
                    depthLoadOp: "clear",
                    depthStoreOp: "store"
                }
            });
            prepass.setPipeline(this.prepassPipeline!);
            this.drawScene(prepass);
            prepass.end();
        }

        if (this.options.cullClusters) {
            this.lights.markActiveClusters(encoder, this.markClustersBindGroup!);
            this.lights.doLightClustering(encoder, true);
        }

        const renderPass = encoder.beginRenderPass({
            label: "forward plus render pass",
            timestampWrites: renderer.gpuTimer.pass("render"),
            colorAttachments: [
                {
                    view: canvasTextureView,
                    clearValue: [0, 0, 0, 0],
                    loadOp: "clear",
                    storeOp: "store"
                }
            ],
            depthStencilAttachment: {
                view: this.depthTextureView,
                depthClearValue: 1.0,
                depthLoadOp: this.options.prepass ? "load" : "clear",
                depthStoreOp: "store"
            }
        });
        renderPass.setPipeline(this.pipeline);
        this.drawScene(renderPass);
        renderPass.end();

        renderer.gpuTimer.resolve(encoder);
        renderer.device.queue.submit([encoder.finish()]);
    }
}
