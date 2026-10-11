
// See naive.fs.wgsl for basic fragment shader setup; this shader should use light clusters instead of looping over all lights

// ------------------------------------
// Shading process:
// ------------------------------------
// Determine which cluster contains the current fragment.
// Retrieve the number of lights that affect the current fragment from the cluster’s data.
// Initialize a variable to accumulate the total light contribution for the fragment.
// For each light in the cluster:
//     Access the light's properties using its index.
//     Calculate the contribution of the light based on its position, the fragment’s position, and the surface normal.
//     Add the calculated contribution to the total light accumulation.
// Multiply the fragment’s diffuse color by the accumulated light contribution.
// Return the final color, ensuring that the alpha component is set appropriately (typically to 1).


@group(${bindGroup_scene}) @binding(0) var<uniform> cameraUniforms: CameraUniforms;
@group(${bindGroup_scene}) @binding(1) var<storage, read> lightSet: LightSet;
@group(${bindGroup_scene}) @binding(2) var<storage, read> clusterSet: ClusterSet;

@group(${bindGroup_material}) @binding(0) var diffuseTex: texture_2d<f32>;
@group(${bindGroup_material}) @binding(1) var diffuseTexSampler: sampler;

struct FragmentInput
{
    @builtin(position) fragPos: vec4f,
    @location(0) pos: vec3f,
    @location(1) nor: vec3f,
    @location(2) uv: vec2f
}

@fragment
fn main(in: FragmentInput) -> @location(0) vec4f
{
    let tileX = u32(clamp(floor(in.fragPos.x / cameraUniforms.screenWidth * f32(${clusterDimX})), 0.0, f32(${clusterDimX} - 1)));
    let tileY = u32(clamp(floor(in.fragPos.y / cameraUniforms.screenHeight * f32(${clusterDimY})), 0.0, f32(${clusterDimY} - 1)));

    let viewPos = cameraUniforms.viewMat * vec4f(in.pos, 1.0);
    let d = -viewPos.z;
    let sliceF = floor(log(d / cameraUniforms.nearPlane) / log(cameraUniforms.farPlane / cameraUniforms.nearPlane) * f32(${clusterDimZ}));
    let slice = u32(clamp(sliceF, 0, ${clusterDimZ - 1}));

    let clusterIdx = tileX + tileY * ${clusterDimX} + slice * ${clusterDimX} * ${clusterDimY};
    let cluster = &clusterSet.clusters[clusterIdx];

    let diffuseColor = textureSample(diffuseTex, diffuseTexSampler, in.uv);
    if (diffuseColor.a < 0.5f) {
        discard;
    }

    var totalLightContrib = vec3f(0, 0, 0);
    for (var lightIdx = 0u; lightIdx < (*cluster).numLights; lightIdx++) {
        let light = lightSet.lights[(*cluster).lightIndices[lightIdx]];
        totalLightContrib += calculateLightContrib(light, in.pos, normalize(in.nor));
    }

    // debug views, controlled by forwardPlusDebugMode in shaders.ts
    if (${forwardPlusDebugMode} == 1) {
        return vec4f(hashColor(clusterIdx), 1);
    }
    if (${forwardPlusDebugMode} == 2) {
        let numLights = (*cluster).numLights;
        if (numLights >= ${maxLightsPerCluster}u) {
            return vec4f(0, 0, 1, 1); // blue = cluster is full, lights are being dropped
        }
        return vec4f(clamp(f32(numLights) / f32(${maxLightsPerCluster}), 0.0, 1.0), 0, 0, 1);
    }

    var finalColor = diffuseColor.rgb * totalLightContrib;
    return vec4(finalColor, 1);
}

// pseudo-random color from an integer id
fn hashColor(id: u32) -> vec3f {
    let f = f32(id);
    return vec3f(
        fract(sin(f * 12.9898) * 43758.5453),
        fract(sin(f * 78.233) * 24634.6345),
        fract(sin(f * 39.346) * 31415.9265)
    );
}
