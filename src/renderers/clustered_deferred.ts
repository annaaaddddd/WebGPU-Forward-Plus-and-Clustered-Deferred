import * as renderer from '../renderer';
import * as shaders from '../shaders/shaders';
import { Stage } from '../stage/stage';

export class ClusteredDeferredRenderer extends renderer.Renderer {
    // g buffer pass
    gBufferBindGroupLayout: GPUBindGroupLayout;
    gBufferSceneBindGroup: GPUBindGroup;

    depthTexture: GPUTexture;
    depthTextureView: GPUTextureView;
    positionTexture: GPUTexture;
    positionTextureView: GPUTextureView;
    normalTexture: GPUTexture;
    normalTextureView: GPUTextureView;
    albedoTexture: GPUTexture;
    albedoTextureView: GPUTextureView;

    gBufferPipeline: GPURenderPipeline;

    // fullscreen pass 
    sceneUniformsBindGroupLayout: GPUBindGroupLayout;
    sceneUniformsBindGroup: GPUBindGroup;

    gBufferTexturesBindGroupLayout: GPUBindGroupLayout;
    gBufferTexturesBindGroup: GPUBindGroup;

    fullscreenPipeline: GPURenderPipeline;

    // options.cullClusters: mark the clusters behind the G-buffer's visible pixels and only cluster
    // lights for those; the G-buffer pass already provides the depth, so no extra geometry pass
    markClustersBindGroup: GPUBindGroup | undefined;

    constructor(stage: Stage, options: renderer.RendererOptions = {}) {
        super(stage, options);

        // initialize layouts, pipelines, textures, etc. needed for g buffer pass here
        this.gBufferBindGroupLayout = renderer.device.createBindGroupLayout({
            label: "deferred g buffer pass bind group layout",
            entries: [
                { // camera
                    binding: 0,
                    visibility: GPUShaderStage.VERTEX,
                    buffer: { type: "uniform" }
                }
            ]
        });
        this.gBufferSceneBindGroup = renderer.device.createBindGroup({
            label: "deferred g buffer pass bind group",
            layout: this.gBufferBindGroupLayout,
            entries: [
                {
                    binding: 0,
                    resource: { buffer: this.camera.uniformsBuffer }
                }
            ]
        });

        this.depthTexture = renderer.device.createTexture({
            size: [renderer.canvas.width, renderer.canvas.height],
            format: "depth24plus",
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING // read by the mark pass
        });
        this.depthTextureView = this.depthTexture.createView();

        if (this.options.cullClusters) {
            this.markClustersBindGroup = this.lights.createMarkClustersBindGroup(this.depthTextureView);
        }

        this.positionTexture = renderer.device.createTexture({
            size: [renderer.canvas.width, renderer.canvas.height],
            format: "rgba16float",
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING
        });
        this.positionTextureView = this.positionTexture.createView();

        this.normalTexture = renderer.device.createTexture({
            size: [renderer.canvas.width, renderer.canvas.height],
            format: "rgba16float",
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING
        });
        this.normalTextureView = this.normalTexture.createView();

        this.albedoTexture = renderer.device.createTexture({
            size: [renderer.canvas.width, renderer.canvas.height],
            format: "rgba8unorm",
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING
        });
        this.albedoTextureView = this.albedoTexture.createView();

        this.gBufferPipeline = renderer.device.createRenderPipeline({
            layout: renderer.device.createPipelineLayout({
                label: "deferred g buffer pass pipeline layout",
                bindGroupLayouts: [
                    this.gBufferBindGroupLayout,
                    renderer.modelBindGroupLayout,
                    renderer.materialBindGroupLayout
                ]
            }),
            depthStencil: {
                depthWriteEnabled: true,
                depthCompare: "less",
                format: "depth24plus"
            },
            vertex: {
                module: renderer.device.createShaderModule({
                    label: "deferred g buffer pass vert shader",
                    code: shaders.naiveVertSrc
                }),
                buffers: [ renderer.vertexBufferLayout ]
            },
            fragment: {
                module: renderer.device.createShaderModule({
                    label: "deferred g buffer pass frag shader",
                    code: shaders.clusteredDeferredFragSrc,
                }),
                targets: [
                    { format: "rgba16float" },   // location(0) -> positionTexture
                    { format: "rgba16float" },   // location(1) -> normalTexture
                    { format: "rgba8unorm" }     // location(2) -> albedoTexture
                ]
            }
        });

        // full screen pass
        this.sceneUniformsBindGroupLayout = renderer.device.createBindGroupLayout({
            label: "deferred full screen pass: scene uniforms bind group layout",
            entries: [
                { // camera
                    binding: 0,
                    visibility: GPUShaderStage.FRAGMENT,
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
            label: "deferred full screen pass: scene uniforms bind group",
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

        this.gBufferTexturesBindGroupLayout = renderer.device.createBindGroupLayout({
            label: "deferred full screen pass: g buffer texture bind group layout",
                entries: [
                    { // position
                        binding: 0,
                        visibility: GPUShaderStage.FRAGMENT,
                        texture: {}
                    },
                    { // normal
                        binding: 1,
                        visibility: GPUShaderStage.FRAGMENT,
                        texture: {}
                    },
                    { // albedo
                        binding: 2,
                        visibility: GPUShaderStage.FRAGMENT,
                        texture: {}
                    }
                ]
        });
        this.gBufferTexturesBindGroup = renderer.device.createBindGroup({
            label: "deferred full screen pass: g buffer texture bind group",
            layout: this.gBufferTexturesBindGroupLayout,
            entries: [
                {
                    binding: 0,
                    resource: this.positionTextureView
                },
                {
                    binding: 1,
                    resource: this.normalTextureView
                },
                {
                    binding: 2,
                    resource: this.albedoTextureView
                }
            ]
        });

        this.fullscreenPipeline = renderer.device.createRenderPipeline({
            layout: renderer.device.createPipelineLayout({
                label: "deferred full screen pipeline layout",
                bindGroupLayouts: [
                    this.sceneUniformsBindGroupLayout,
                    this.gBufferTexturesBindGroupLayout
                ]
            }),
            vertex: {
                module: renderer.device.createShaderModule({
                    label: "deferred full screen vert shader",
                    code: shaders.clusteredDeferredFullscreenVertSrc
                }),
                buffers: [ ]
            },
            fragment: {
                module: renderer.device.createShaderModule({
                    label: "deferred full screen frag shader",
                    code: shaders.clusteredDeferredFullscreenFragSrc,
                }),
                targets: [
                    {
                        format: renderer.canvasFormat,
                    }
                ]
            }
        });
    }

    override draw() {
        const encoder = renderer.device.createCommandEncoder();
        const canvasTextureView = renderer.context.getCurrentTexture().createView();

        if (!this.options.cullClusters) {
            this.lights.doLightClustering(encoder);
        }

        const gBufferPass = encoder.beginRenderPass({
            label: "deferred g buffer pass",
            timestampWrites: renderer.gpuTimer.pass("gbuffer"),
            colorAttachments: [
                {
                    view: this.positionTextureView,
                    clearValue: [0, 0, 0, 0],
                    loadOp: "clear",
                    storeOp: "store"
                },
                {
                    view: this.normalTextureView,
                    clearValue: [0, 0, 0, 0],
                    loadOp: "clear",
                    storeOp: "store"
                },
                {
                    view: this.albedoTextureView,
                    clearValue: [0, 0, 0, 0],
                    loadOp: "clear",
                    storeOp: "store"
                },
            ],
            depthStencilAttachment: {
                view: this.depthTextureView,
                depthClearValue: 1.0,
                depthLoadOp: "clear",
                depthStoreOp: "store"
            }
        });
        gBufferPass.setPipeline(this.gBufferPipeline);
        gBufferPass.setBindGroup(shaders.constants.bindGroup_scene, this.gBufferSceneBindGroup);
        this.scene.iterate(node => {
            gBufferPass.setBindGroup(shaders.constants.bindGroup_model, node.modelBindGroup);
        }, material => {
            gBufferPass.setBindGroup(shaders.constants.bindGroup_material, material.materialBindGroup);
        }, primitive => {
            gBufferPass.setVertexBuffer(0, primitive.vertexBuffer);
            gBufferPass.setIndexBuffer(primitive.indexBuffer, 'uint32');
            gBufferPass.drawIndexed(primitive.numIndices);
        });

        gBufferPass.end();

        if (this.options.cullClusters) {
            this.lights.markActiveClusters(encoder, this.markClustersBindGroup!);
            this.lights.doLightClustering(encoder, true);
        }

        const fullscreenPass = encoder.beginRenderPass({
            label: "deferred full screeen pass",
            timestampWrites: renderer.gpuTimer.pass("fullscreen"),
            colorAttachments: [
                {
                    view: canvasTextureView,
                    clearValue: [0, 0, 0, 0],
                    loadOp: "clear",
                    storeOp: "store"
                }
            ]
        });
        fullscreenPass.setPipeline(this.fullscreenPipeline);
        fullscreenPass.setBindGroup(shaders.constants.bindGroup_scene, this.sceneUniformsBindGroup);
        fullscreenPass.setBindGroup(shaders.constants.bindGroup_gbuffer, this.gBufferTexturesBindGroup);
        fullscreenPass.draw(3);

        fullscreenPass.end();

        renderer.gpuTimer.resolve(encoder);
        renderer.device.queue.submit([encoder.finish()]);
    }
}
