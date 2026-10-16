// depth-only prepass for Forward+: no color output, only the alpha test so cutouts don't write depth

@group(${bindGroup_material}) @binding(0) var diffuseTex: texture_2d<f32>;
@group(${bindGroup_material}) @binding(1) var diffuseTexSampler: sampler;

struct FragmentInput
{
    @location(2) uv: vec2f
}

@fragment
fn main(in: FragmentInput)
{
    // alpha test only, nothing to return
    let sample = textureSample(diffuseTex, diffuseTexSampler, in.uv);
    if (sample.a < 0.5)
    {
        discard;
    }
}
