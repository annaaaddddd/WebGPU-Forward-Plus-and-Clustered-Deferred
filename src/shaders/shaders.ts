// CHECKITOUT: this file loads all the shaders and preprocesses them with some common code

import { Camera } from '../stage/camera';

import commonRaw from './common.wgsl?raw';

import naiveVertRaw from './naive.vs.wgsl?raw';
import naiveFragRaw from './naive.fs.wgsl?raw';

import forwardPlusFragRaw from './forward_plus.fs.wgsl?raw';
import depthPrepassFragRaw from './depth_prepass.fs.wgsl?raw';

import clusteredDeferredFragRaw from './clustered_deferred.fs.wgsl?raw';
import clusteredDeferredFullscreenVertRaw from './clustered_deferred_fullscreen.vs.wgsl?raw';
import clusteredDeferredFullscreenFragRaw from './clustered_deferred_fullscreen.fs.wgsl?raw';

import moveLightsComputeRaw from './move_lights.cs.wgsl?raw';
import clusteringComputeRaw from './clustering.cs.wgsl?raw';
import markClustersComputeRaw from './mark_clusters.cs.wgsl?raw';

// CONSTANTS (for use in shaders)
// =================================

// CHECKITOUT: feel free to add more constants here and to refer to them in your shader code

// Note that these are declared in a somewhat roundabout way because otherwise minification will drop variables
// that are unused in host side code.
// cluster grid dimensions (tiles in X/Y, depth slices in Z)
const clusterDimX = 16;
const clusterDimY = 9;
const clusterDimZ = 24;

export const constants = {
    bindGroup_scene: 0,
    bindGroup_model: 1,
    bindGroup_material: 2,
    bindGroup_gbuffer: 1,

    moveLightsWorkgroupSize: 128,

    lightRadius: 2,

    clusterDimX: clusterDimX,
    clusterDimY: clusterDimY,
    clusterDimZ: clusterDimZ,
    numClusters: clusterDimX * clusterDimY * clusterDimZ,
    maxLightsPerCluster: 1024,
    clusteringWorkgroupSize: 128,

    // cluster debug view (Forward+ and Clustered Deferred): 0 = off, 1 = random color per cluster, 2 = lights-per-cluster heatmap
    clusterDebugMode: 0
};

// =================================

// replaces every ${expr} in a shader with the value of expr, evaluated with all constants in scope.
// The constants are passed in through Object.keys/values on purpose: a static `constants.x` access
// lets the production bundler strip constants that only shaders use (lightRadius was dropped that way).
const constantNames = Object.keys(constants);
const constantValues = Object.values(constants);
function evalShaderRaw(raw: string) {
    return raw.replace(/\$\{([^}]*)\}/g, (_, expr: string) =>
        String(new Function(...constantNames, `return (${expr});`)(...constantValues)));
}

const commonSrc: string = evalShaderRaw(commonRaw);

function processShaderRaw(raw: string) {
    return commonSrc + evalShaderRaw(raw);
}

export const naiveVertSrc: string = processShaderRaw(naiveVertRaw);
export const naiveFragSrc: string = processShaderRaw(naiveFragRaw);

export const forwardPlusFragSrc: string = processShaderRaw(forwardPlusFragRaw);
export const depthPrepassFragSrc: string = processShaderRaw(depthPrepassFragRaw);

export const clusteredDeferredFragSrc: string = processShaderRaw(clusteredDeferredFragRaw);
export const clusteredDeferredFullscreenVertSrc: string = processShaderRaw(clusteredDeferredFullscreenVertRaw);
export const clusteredDeferredFullscreenFragSrc: string = processShaderRaw(clusteredDeferredFullscreenFragRaw);

export const moveLightsComputeSrc: string = processShaderRaw(moveLightsComputeRaw);
export const clusteringComputeSrc: string = processShaderRaw(clusteringComputeRaw);
export const markClustersComputeSrc: string = processShaderRaw(markClustersComputeRaw);
