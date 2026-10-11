// CHECKITOUT: code that you add here will be prepended to all shaders

struct Light {
    pos: vec3f,
    color: vec3f
}

struct LightSet {
    numLights: u32,
    lights: array<Light>
}

// TODO-2: you may want to create a ClusterSet struct similar to LightSet
struct Cluster {
    numLights: u32,
    lightIndices: array<u32, ${maxLightsPerCluster}>
}

struct ClusterSet {
    clusters: array<Cluster, ${numClusters}>
}

struct CameraUniforms {
    viewProj: mat4x4f,
    viewMat: mat4x4f,
    inverseProjMat: mat4x4f,
    screenWidth: f32,
    screenHeight: f32,
    nearPlane: f32,
    farPlane: f32
}

// CHECKITOUT: this special attenuation function ensures lights don't affect geometry outside the maximum light radius
fn rangeAttenuation(distance: f32) -> f32 {
    return clamp(1.f - pow(distance / ${lightRadius}, 4.f), 0.f, 1.f) / (distance * distance);
}

fn calculateLightContrib(light: Light, posWorld: vec3f, nor: vec3f) -> vec3f {
    let vecToLight = light.pos - posWorld;
    let distToLight = length(vecToLight);

    let lambert = max(dot(nor, normalize(vecToLight)), 0.f);
    return light.color * lambert * rangeAttenuation(distToLight);
}

fn aabbLightIntersection(lightCenter: vec3f, aabbMin: vec3f, aabbMax: vec3f) -> bool {
    let closetPoint = clamp(lightCenter, aabbMin, aabbMax);

    let distanceToCenterSquared = dot(closetPoint - lightCenter, closetPoint - lightCenter);
    let lightRadiusSquared = f32(${lightRadius}) * f32(${lightRadius});

    return distanceToCenterSquared < lightRadiusSquared;
}