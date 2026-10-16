
// ------------------------------------
// Calculating cluster bounds:
// ------------------------------------
// For each cluster (X, Y, Z):
//     - Calculate the screen-space bounds for this cluster in 2D (XY).
//     - Calculate the depth bounds for this cluster in Z (near and far planes).
//     - Convert these screen and depth bounds into view-space coordinates.
//     - Store the computed bounding box (AABB) for the cluster.

// ------------------------------------
// Assigning lights to clusters:
// ------------------------------------
// For each cluster:
//     - Initialize a counter for the number of lights in this cluster.

//     For each light:
//         - Check if the light intersects with the cluster’s bounding box (AABB).
//         - If it does, add the light to the cluster's light list.
//         - Stop adding lights if the maximum number of lights is reached.

//     - Store the number of lights assigned to this cluster.

@group(${bindGroup_scene}) @binding(0) var<storage> lightSet: LightSet;
@group(${bindGroup_scene}) @binding(1) var<storage, read_write> clusterSet: ClusterSet;
@group(${bindGroup_scene}) @binding(2) var<uniform> cameraUniforms: CameraUniforms;
// flags from mark_clusters.cs.wgsl, only read when cullClusters is on
@group(${bindGroup_scene}) @binding(3) var<storage> activeClusters: array<u32>;

// set per pipeline, so the same shader builds with and without culling
override cullClusters: bool = false;

@compute 
@workgroup_size(${clusteringWorkgroupSize})
fn main(@builtin(global_invocation_id) globalIdx: vec3u) {
    let idx = globalIdx.x;
    if (idx >= ${numClusters}) {
        return;
    }

    if (cullClusters && activeClusters[idx] == 0u)
    {
        clusterSet.clusters[idx].numLights = 0;
        return;
    }

    let x = idx % ${clusterDimX};
    let y = (idx / ${clusterDimX}) % ${clusterDimY};
    let z = idx / (${clusterDimX} * ${clusterDimY});

    // calculate ndc range for tile
    let ndcMinX = (f32(x)/ ${clusterDimX}) * 2  - 1;
    let ndcMaxX = (f32(x + 1)/ ${clusterDimX}) * 2  - 1;
    let ndcMaxY = -((f32(y) / ${clusterDimY}) * 2 - 1);
    let ndcMinY = -((f32(y + 1) / ${clusterDimY}) * 2 - 1);

    // calculate depth (positive distances from the camera)
    let depthNear = cameraUniforms.nearPlane * pow(cameraUniforms.farPlane / cameraUniforms.nearPlane, f32(z) / ${clusterDimZ});
    let depthFar = cameraUniforms.nearPlane * pow(cameraUniforms.farPlane / cameraUniforms.nearPlane, f32(z + 1) / ${clusterDimZ});

    // unproject the two diagonal corners of the tile into view space (divide by w to leave homogeneous coords)
    let viewMinH = cameraUniforms.inverseProjMat * vec4f(ndcMinX, ndcMinY, 1.0, 1.0);
    let viewMaxH = cameraUniforms.inverseProjMat * vec4f(ndcMaxX, ndcMaxY, 1.0, 1.0);
    let viewMin = viewMinH.xyz / viewMinH.w;
    let viewMax = viewMaxH.xyz / viewMaxH.w;

    // slide each corner along its ray from the camera onto the near and far slice planes
    // (view space looks down -z, so the planes are at z = -depth)
    let minNear = viewMin * (-depthNear / viewMin.z);
    let minFar = viewMin * (-depthFar / viewMin.z);
    let maxNear = viewMax * (-depthNear / viewMax.z);
    let maxFar = viewMax * (-depthFar / viewMax.z);

    // view-space AABB of this cluster
    let aabbMin = min(min(minNear, minFar), min(maxNear, maxFar));
    let aabbMax = max(max(minNear, minFar), max(maxNear, maxFar));


    var count = 0u;
    for (var i : u32 = 0u; i < lightSet.numLights; i += 1u)
    {
        if (count >= ${maxLightsPerCluster}) { break; }
        let light = lightSet.lights[i];

        let lightViewPosH = cameraUniforms.viewMat * vec4f(light.pos, 1.0);
        let lightViewPos = lightViewPosH.xyz;

        let isIntersect = aabbLightIntersection(lightViewPos, aabbMin, aabbMax); 

        if (isIntersect) 
        {
            clusterSet.clusters[idx].lightIndices[count] = i;
            count++;
        }
    }
    clusterSet.clusters[idx].numLights = count;
}
