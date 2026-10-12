// Clustered Deferred fullscreen vertex shader

// Fullscreen triangle: no vertex buffer, draw(3) calls this shader with vertex_index 0, 1, 2.
// The three NDC points form a right triangle whose hypotenuse passes through (1, 1), so it
// covers the whole [-1, 1] screen square; the parts outside are clipped. One triangle instead
// of two avoids a diagonal seam and lets every pixel run the fragment shader exactly once.
const positions = array<vec2f, 3>(
    vec2f(-1, -1),
    vec2f(3, -1),
    vec2f(-1, 3)
);

@vertex
fn main(@builtin(vertex_index) idx: u32) -> @builtin(position) vec4f {
    let p = positions[idx];
    return vec4f(p, 0.0, 1.0);
}
