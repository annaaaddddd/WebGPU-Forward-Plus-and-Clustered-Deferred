// marks clusters that contain visible geometry, one thread per pixel of the depth buffer
// the clustering pass then skips clusters whose flag is still 0

@group(0) @binding(0) var<uniform> cameraUniforms: CameraUniforms;
@group(0) @binding(1) var depthTex: texture_depth_2d;
@group(0) @binding(2) var<storage, read_write> activeClusters: array<u32>;

@compute
@workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) gid: vec3u) {
    let dims = textureDimensions(depthTex);
    if (gid.x >= dims.x || gid.y >= dims.y) {
        return;
    }

    let depth = textureLoad(depthTex, vec2i(gid.xy), 0);

    if (depth >= 1.0) 
    {
        return;
    }

    let ndcPt = vec3f(
                    (f32(gid.x) + 0.5) / f32(dims.x) * 2.0 - 1.0, 
                    1.0 - (f32(gid.y) + 0.5) / f32(dims.y) * 2.0, 
                    depth);
    let viewPtH = cameraUniforms.inverseProjMat * vec4f(ndcPt, 1.0);
    let viewPt = viewPtH.xyz / viewPtH.w;
    let viewSpaceDepth = -viewPt.z;

    let tileX = u32(clamp(floor((f32(gid.x) + 0.5) / cameraUniforms.screenWidth * f32(${clusterDimX})), 0.0, f32(${clusterDimX} - 1)));
    let tileY = u32(clamp(floor((f32(gid.y) + 0.5) / cameraUniforms.screenHeight * f32(${clusterDimY})), 0.0, f32(${clusterDimY} - 1)));

    let sliceF = floor(log(viewSpaceDepth / cameraUniforms.nearPlane) / log(cameraUniforms.farPlane / cameraUniforms.nearPlane) * f32(${clusterDimZ}));
    let slice = u32(clamp(sliceF, 0, ${clusterDimZ - 1}));

    let clusterIdx = tileX + tileY * ${clusterDimX} + slice * ${clusterDimX} * ${clusterDimY};

    activeClusters[clusterIdx] = 1u;
}
