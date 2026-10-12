// TODO-3: implement the Clustered Deferred fullscreen fragment shader

// Similar to the Forward+ fragment shader, but with vertex information coming from the G-buffer instead.

@group(${bindGroup_scene}) @binding(0) var<uniform> cameraUniforms: CameraUniforms;
@group(${bindGroup_scene}) @binding(1) var<storage, read> lightSet: LightSet;
@group(${bindGroup_scene}) @binding(2) var<storage, read> clusterSet: ClusterSet;

@group(${bindGroup_gbuffer}) @binding(0) var gPosition: texture_2d<f32>;
@group(${bindGroup_gbuffer}) @binding(1) var gNormal: texture_2d<f32>;
@group(${bindGroup_gbuffer}) @binding(2) var gAlbedo: texture_2d<f32>;

@fragment
fn main(@builtin(position) fragPos: vec4f) -> @location(0) vec4f
{
    let gBufferPostionLoad = textureLoad(gPosition, vec2i(fragPos.xy), 0);
    let gBufferPos = gBufferPostionLoad.xyz;
    let gBufferNormalLoad = textureLoad(gNormal, vec2i(fragPos.xy), 0);
    let gBufferNor = gBufferNormalLoad.xyz;
    let gBufferAlbedoLoad = textureLoad(gAlbedo, vec2i(fragPos.xy), 0);
    let gBufferAlb = gBufferAlbedoLoad.xyz;
    
    let tileX = u32(clamp(floor(fragPos.x / cameraUniforms.screenWidth * f32(${clusterDimX})), 0.0, f32(${clusterDimX} - 1)));
    let tileY = u32(clamp(floor(fragPos.y / cameraUniforms.screenHeight * f32(${clusterDimY})), 0.0, f32(${clusterDimY} - 1)));

    let viewPos = cameraUniforms.viewMat * vec4f(gBufferPos, 1.0);
    let d = -viewPos.z;
    let sliceF = floor(log(d / cameraUniforms.nearPlane) / log(cameraUniforms.farPlane / cameraUniforms.nearPlane) * f32(${clusterDimZ}));
    let slice = u32(clamp(sliceF, 0, ${clusterDimZ - 1}));

    let clusterIdx = tileX + tileY * ${clusterDimX} + slice * ${clusterDimX} * ${clusterDimY};
    let cluster = &clusterSet.clusters[clusterIdx];

    var totalLightContrib = vec3f(0, 0, 0);
    for (var lightIdx = 0u; lightIdx < (*cluster).numLights; lightIdx++) {
        let light = lightSet.lights[(*cluster).lightIndices[lightIdx]];
        totalLightContrib += calculateLightContrib(light, gBufferPos, normalize(gBufferNor));
    }

    // debug views, controlled by clusterDebugMode in shaders.ts
    if (${clusterDebugMode} == 1) {
        return vec4f(hashColor(clusterIdx), 1);
    }
    if (${clusterDebugMode} == 2) {
        let numLights = (*cluster).numLights;
        if (numLights >= ${maxLightsPerCluster}u) {
            return vec4f(0, 0, 1, 1); // blue = cluster is full, lights are being dropped
        }
        return vec4f(clamp(f32(numLights) / f32(${maxLightsPerCluster}), 0.0, 1.0), 0, 0, 1);
    }

    var finalColor = gBufferAlb * totalLightContrib;
    return vec4(finalColor, 1);
}
