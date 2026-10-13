WebGPU Forward+ and Clustered Deferred Shading
======================

University of Pennsylvania, CIS 5650: GPU Programming and Architecture, Project 4

* Anna Dai <!-- TODO:  add LinkedIn or personal site -->
* Tested on: Google Chrome 155.0.8059.39 on
  Windows 11 Home, AMD Ryzen 9 5950X (16 cores) 128 GB, NVIDIA GeForce RTX 3090 Ti (driver 32.0.16.1656)

### Live Demo

[https://annaaaddddd.github.io/WebGPU-Forward-Plus-and-Clustered-Deferred](https://annaaaddddd.github.io/WebGPU-Forward-Plus-and-Clustered-Deferred)

### Demo

<!-- TODO: 30+ second video/gif showing all features -->

![Forward+ with 5000 lights](images/forward_plus_5000_lights.jpg)

*Forward+ renderer, Sponza, 5000 point lights, cluster cap 1024.*

## Overview

This project renders the Sponza atrium under thousands of moving point lights and compares three
ways of shading it.

* Naive forward evaluates every light for every fragment.
* Forward+ first sorts the lights into a 3D grid of view-frustum clusters with a compute shader,
  so each fragment only loops over the lights near it.
* Clustered Deferred uses the same clusters, but writes a G-buffer first and does the lighting in a
  fullscreen pass, so lighting runs once per pixel.

## Forward+

### How the clustering works

The view frustum is cut into 16 x 9 screen tiles and 24 depth slices, 3456 clusters in total.
Each frame a compute shader (`src/shaders/clustering.cs.wgsl`) rebuilds the light list of every
cluster, and the fragment shader (`forward_plus.fs.wgsl`) only loops over the list of its own cluster.

Cluster bounds are computed in view space.

* Depth slices are exponential between near (0.1) and far (1000). Slice `z` spans
  `near * (far/near)^(z/24)` to `near * (far/near)^((z+1)/24)`.
* The two diagonal corners of a tile are unprojected with the inverse projection matrix, then slid
  along their view rays to the slice's near and far depth.
  * The AABB of those four points bounds the whole frustum slice.
  * This works because in a perspective projection, view-space x depends only on NDC x and depth
    (and y only on NDC y and depth).

Light assignment uses one thread per cluster, with a workgroup size of 128.

* Every light is moved into view space and tested against the cluster AABB with a sphere-vs-box
  closest-point test (`aabbLightIntersection` in `common.wgsl`).
* Hits are appended to a fixed-size index list, capped at `maxLightsPerCluster` (currently 1024).
* Each cluster is stored as `Cluster { numLights: u32, lightIndices: array<u32, cap> }`.
  * With a cap of 1024 the buffer is 3456 x (1 + 1024) x 4 B = 14.2 MB.
  * With a cap of 256 it is 3.6 MB.

In the fragment shader, the cluster index comes from `@builtin(position)` and the view-space depth,
using the inverse of the slice formula. The cluster is read through a pointer, so the 4 KB struct is
never copied.

### Debug views

`clusterDebugMode` in `src/shaders/shaders.ts` switches the output of both the Forward+ and the
Clustered Deferred renderer.

* Mode `1` colors each cluster with a hash of its index, which makes the tile grid and the depth
  slices visible.
* Mode `2` shows `numLights / cap` as red intensity.
  * A cluster that has reached the cap is painted blue. From that point on, any further light that
    touches it is dropped.
  * The cap analysis below uses this view together with a readback of the cluster buffer.

| Cluster id (500 lights) | Lights-per-cluster heatmap (500 lights, cap 256) |
|---|---|
| ![](images/debug_forward_plus_cluster_id.png) | ![](images/debug_forward_plus_light_heatmap.png) |

## Clustered Deferred

The clustering compute pass is reused unchanged. Rendering is split into two passes inside the same
command encoder.

* The G-buffer pass (`clustered_deferred.fs.wgsl`) draws the scene with the naive vertex shader and
  does no lighting.
  * It writes world position and normal as `rgba16float` (8 B each), albedo as `rgba8unorm` (4 B),
    plus the usual depth buffer.
  * Alpha-tested fragments are discarded here, so the fullscreen pass never sees them.
* The fullscreen pass (`clustered_deferred_fullscreen.vs/fs.wgsl`) draws one screen-covering
  triangle with `draw(3)` and no vertex buffer.
  * The fragment shader reads the three G-buffer textures with `textureLoad` at its own pixel.
  * It then runs the same cluster lookup and lighting loop as Forward+.
* The G-buffer textures live in their own bind group (`bindGroup_gbuffer`), next to the scene bind
  group that Forward+ already uses.

## Performance Analysis

### How the numbers were measured

All timings come from the in-page benchmark in `src/benchmark.ts`, run from the browser console at
the default camera position (pos [-7, 2, 0], yaw 0, pitch 0). Results are in milliseconds per frame.

```
await benchmark()                                    // full sweep: 500 / 1000 / 2000 / 5000 lights
await benchmark({ lightCounts: [1] })                // fixed overhead
await clusterStats({ numLights: 5000, frames: 20 })  // cluster readback, 20 samples 0.5 s apart
```

While the benchmark runs, the render loop switches to a serialized path (`Renderer.timedFrame` in
`src/renderer.ts`). One sample is measured like this:

1. Wait for the light-movement compute pass to finish, so it is not counted.
2. Record `performance.now()`, call `draw()`, and wait for `queue.onSubmittedWorkDone()`.
3. The elapsed time is the sample. It covers CPU command encoding, GPU execution and the submit and
   completion latency of one frame, with only one frame in flight.

Each pass also writes GPU timestamps (`timestamp-query`), which give the GPU time per pass.

* The timestamps are mapped and read after the wall clock has stopped. Only the resolve and copy
  commands are recorded inside the timed frame.
* The GPU times come in steps of about 0.066 ms, and `performance.now()` has a resolution of 0.1 ms.

Samples are aggregated in three steps.

* For every (lights, mode) pair, 30 warm-up frames are discarded and the median of the next 200
  frames is kept, for both the wall clock and each GPU pass.
* The whole sweep is repeated 3 times per page session. Modes for the same light count run back to
  back, so GPU clock and thermal drift affect every mode about equally.
* The main comparison pools four separate cap-1024 sessions, 12 rounds in total. The reported value
  is the median of the 12 per-round medians (the mean of the middle two), and the range is their
  min and max.

All runs are at 2560 x 1271 (maximized Chrome window, DevTools undocked). Every CSV row stores the
canvas size and the cluster cap, and only runs at the same canvas size are compared. The canvas
size is fixed when the page loads, so reload after changing the window and check the first line the
benchmark prints.

Raw data in `results/`:

```
results_cap1024_2560x1271_gpu_3rounds.csv             # main run with per-pass GPU times
results_cap1024_2560x1271_3rounds.csv                 # cap 1024, earlier session
results_cap1024_2560x1271_abab2.csv / abab4.csv       # cap 1024, alternating with cap 256
results_cap256_2560x1271_abab1.csv / abab3.csv        # cap 256, alternating with cap 1024
results_cap256_2560x1271_3rounds.csv                  # cap 256, earlier session
results_cap2048_2560x1271_5000lights_gpu_3rounds.csv  # cap 2048, 5000 lights only
results_1light_cap1024_2560x1271_gpu_3rounds.csv      # 1 light, fixed overhead
results_1light_cap1024_2560x1271_3rounds.csv          # 1 light, repeat without GPU columns
cluster_stats_default_view.csv                        # cluster buffer readback, per cap
cluster_stats_per_slice_default_view.csv              # same, per depth slice
```

### Naive vs. Forward+ vs. Clustered Deferred

Wall-clock time, cap 1024, median of 12 rounds from four sessions.

| Lights | Naive (ms) | range | Forward+ (ms) | range | Deferred (ms) | range | F+ vs naive | Deferred vs naive | Deferred vs F+ |
|---:|---:|---|---:|---|---:|---|---:|---:|---:|
| 500  | 36.0  | 34.9-36.5   | 6.0  | 4.9-6.0   | 3.2 | 3.1-3.5  | 6.0x  | 11.3x | 1.9x |
| 1000 | 71.0  | 69.9-78.1   | 7.2  | 6.1-8.2   | 3.5 | 3.1-3.6  | 9.9x  | 20.3x | 2.1x |
| 2000 | 141.1 | 140.5-159.0 | 12.6 | 11.5-13.1 | 6.0 | 5.9-6.0  | 11.2x | 23.5x | 2.1x |
| 5000 | 351.8 | 350.5-360.9 | 29.5 | 28.0-30.5 | 9.0 | 8.4-10.0 | 11.9x | 39.1x | 3.3x |

![Frame time vs number of lights](images/frame_time_vs_lights.svg)

> Clustered Deferred is the fastest at every light count and Forward+ is second. At 5000 lights
> Deferred takes 9.0 ms, Forward+ 29.5 ms and naive 351.8 ms.

GPU time per pass, from the main run (`results_cap1024_2560x1271_gpu_3rounds.csv`, median of 3 rounds).

| Lights | Naive render | F+ clustering | F+ render | D clustering | D G-buffer | D fullscreen | F+ GPU total | D GPU total |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 500  | 34.0  | 0.20 | 2.95  | 0.26 | 0.66 | 0.79 | 3.08  | 1.77 |
| 1000 | 67.6  | 0.33 | 4.92  | 0.33 | 0.46 | 1.11 | 5.24  | 1.84 |
| 2000 | 138.3 | 0.66 | 10.22 | 0.66 | 0.46 | 2.36 | 10.88 | 3.41 |
| 5000 | 348.8 | 1.64 | 24.90 | 1.57 | 0.46 | 6.10 | 26.54 | 8.13 |

#### Fixed overhead

> Every frame pays about 1.5 to 3 ms on top of the GPU work, so no mode gets below about 3 ms of
> wall clock at this setup.

Wall clock minus GPU time is 1.5 to 3.2 ms in all 12 configurations of the main run, with no trend
across modes or light counts. It is mostly CPU command encoding plus submit and completion latency,
and also includes any gaps between passes that the timestamps do not cover.

* With 1 light, naive and Deferred take 3.0 to 3.2 ms of wall clock in the GPU run.
* The overhead does not simply add to the GPU time. While the GPU time stays below about 1.8 ms,
  the wall clock stays at 3.0 to 3.4 ms. Above that it is roughly GPU time plus 1.5 to 3 ms. So it
  acts more like a floor of about 3 ms that GPU work can partly overlap with.
* GPU timings at very small loads are not reliable.
  * With 1 light, the GPU time of the same pass changes 2x to more than 3x between rounds (naive
    render 0.26 to 0.85 ms, G-buffer 0.72 to 1.44 ms, Forward+ render 0.66 to 2.03 ms).
  * Only Forward+ gets large enough to push the wall clock above the floor, so its wall clock shows
    two levels, 3.1 and 5.0 ms. The repeat file without GPU columns shows a similar split (3.4 and
    5.0 ms).
  * The cause is still unclear. A lower GPU clock under such a light load is possible, but clock
    speeds were not measured.
* The geometry cost is better taken from loaded runs. The G-buffer pass, which does no lighting,
  takes a steady 0.46 ms from 1000 lights up.

#### Scaling with the light count

> On the GPU, all three lighting passes grow almost linearly with the light count. Clustering lowers
> the cost per light. It does not change the shape of the curve.

From 500 to 5000 lights (10x):

* Naive render grows 10.3x, about 0.070 ms per light.
* Forward+ render grows 8.4x and Deferred fullscreen 7.7x.
  * Both still contain a fixed part. With the geometry estimate from the Forward+ vs. Deferred
    section subtracted, the Forward+ lighting grows 9.8x (2.49 to 24.44 ms).
  * The geometry estimate at 500 lights is uncertain, so treat the 9.8x as approximate.
* On the wall clock, Forward+ grows only 4.9x and Deferred 2.8x. That is mostly the fixed overhead
  and the geometry cost being spread over more lighting work.

This is expected for this scene. The lights are spread over the whole atrium, so the number of
lights per cluster grows in proportion to the total. The readback confirms it.

* Going from 2000 to 5000 lights (2.5x), the average non-empty cluster goes from 103 to about 250
  lights, and the busiest cluster from 344 to about 825. Both grow about 2.4x.

#### Clustering cost

> The clustering pass costs about 0.33 ms per 1000 lights. At 5000 lights that is 6% of the Forward+
> GPU time but 19% of the Deferred GPU time.

The pass is O(clusters x lights), and the number of clusters is fixed, so its time is linear in the
light count.

* At 5000 lights it runs 3456 x 5000 = 17.3 M sphere/box tests in 1.64 ms, each with a
  `mat4 x vec4` to move the light into view space.
* Changing the cap to 2048 does not change it, so the size of the cluster buffer does not matter here.

#### Forward+ vs. Deferred lighting

> Forward+ spends about 4x as much GPU time on lighting as Deferred, at every light count from 1000
> up. Both run the same loop, so Forward+ likely runs it about 4x as often per pixel.

To compare only the lighting, the G-buffer pass time (0.46 ms) is subtracted from the Forward+ render
pass as an estimate of its non-lighting work.

* This assumes the two cost about the same. Both sample the albedo texture. The G-buffer pass
  writes 20 B per pixel, while Forward+ writes 4 B but runs the lighting loop in the same invocation.
* It also assumes one run of the loop costs the same in both shaders. Register use and occupancy
  can differ between them, so the ratio is an approximate run count.

| Lights | F+ render minus geometry | D fullscreen | ratio |
|---:|---:|---:|---:|
| 1000 | 4.46  | 1.11 | 4.0x |
| 2000 | 9.76  | 2.36 | 4.1x |
| 5000 | 24.44 | 6.10 | 4.0x |

* At 500 lights the ratio is 3.2x, but it depends strongly on the geometry estimate there (2.9x if
  0.66 ms is subtracted instead), so I do not use it.
* A ratio that stays constant while the light count grows 5x suggests a fixed number of extra
  loop runs per pixel. There are two likely sources.
  * Overdraw. Forward+ has no depth prepass, so a pixel can be shaded several times before the
    final surface wins the depth test.
  * Quad overshading. Fragments are shaded in 2x2 quads, so small triangles shade extra helper
    pixels at their edges. The fullscreen pass has almost none of this.
* A depth prepass would remove the overdraw. Any ratio that remains after it would come from quad
  overshading and the other per-fragment differences above. I have not implemented the prepass yet.

This is also consistent with the wall-clock ratio between the two growing from 1.9x to 3.3x. At low
light counts the fixed overhead and geometry dominate both modes. As the lighting grows, the ratio
moves toward the 4x of the lighting alone.

#### G-buffer cost

> The whole G-buffer pass takes 0.46 to 0.66 ms, so Deferred is faster than Forward+ even at 500
> lights.

* At 500 lights the Deferred GPU total is 1.77 ms and the Forward+ total is 3.08 ms.
* The G-buffer is 2560 x 1271 x 20 B, about 65 MB written per frame and read back once by the
  fullscreen pass. The 0.46 ms includes drawing the geometry, so the bandwidth part is smaller still.
* On a GPU with much less bandwidth this trade-off could flip at low light counts.

#### Trade-offs beyond speed

Deferred wins on speed here, but it gives up some things that Forward+ keeps.

* The G-buffer stores one surface per pixel, so blended transparent surfaces cannot go through it
  and would need a separate forward pass. Sponza only uses alpha testing, which works in both.
* Hardware MSAA does not carry over directly. The G-buffer would have to be multisampled and lit per
  sample, which multiplies its memory and the lighting cost. Forward+ only needs MSAA turned on.
* The three full-screen targets take about 65 MB at 2560 x 1271 on top of the depth buffer. Forward+
  only needs a color and a depth target.
* Deferred needs two render passes, an extra bind group and G-buffer formats that both shaders must
  agree on, so it is more code to write and keep in sync.

#### Variation between rounds and sessions

* Across the four cap-1024 sessions, the per-session medians of Forward+ and Deferred agree within
  1.4 ms, and naive within 5%.
* Naive has two slow rounds in one session (78.1 ms at 1000 lights and 159.0 ms at 2000). The median
  removes them.
* Deferred at 5000 lights falls into two groups, 8.4 to 9.0 ms and 10.0 ms, and its fullscreen pass
  does the same on the GPU (5.2 and 6.1 to 6.3 ms).
  * The lights move with Perlin noise, and the readback shows that the cluster load changes over
    time. Within 10 s the busiest cluster goes from about 825 lights at the median to 1024 or more
    at the peak (842 and 1345 with cap 2048).
  * The two groups are consistent with this change in workload. The benchmark does not record the
    cluster load per round, so this is not confirmed.

### Choosing `maxLightsPerCluster`

The cap limits how many lights a cluster can hold. If it is too small, lights are silently dropped.
If it is too large, the cluster buffer grows. Two tools show where the cap is reached.

* The heatmap debug view shows it on screen.
* `clusterStats()` reads the cluster buffer back. I ran it with 20 samples spread over 10 s, because
  the light layout changes over time and consecutive frames only show one moment.

| 2000 lights, cap 256 | 5000 lights, cap 256 | 5000 lights, cap 1024 |
|---|---|---|
| ![](images/heatmap_2000_lights_cap256.jpg) | ![](images/heatmap_5000_lights_cap256.jpg) | ![](images/heatmap_5000_lights_cap1024.jpg) |

*Red intensity is `numLights / cap`. Blue means the cluster has reached the cap. Each image is a
single frame.*

#### How full the clusters get

Readback at 5000 lights, 20 samples over 10 s. About 1946 of the 3456 clusters are non-empty.

| Cap | Full clusters, median | Full clusters, peak | Busiest cluster, median | Busiest cluster, peak | Buffer |
|---:|---:|---:|---:|---:|---:|
| 256  | 663 (34%) | 1575 (81%) | 256 | 256  | 3.6 MB  |
| 512  | 99 (5%)   | 330 (17%)  | 512 | 512  | 7.1 MB  |
| 1024 | 0         | 52 to 57 (3%) | 824 to 827 | 1024 | 14.2 MB |
| 2048 | 0         | 0          | 842 | 1345 | 28.3 MB |

*Percentages are of the non-empty clusters. Cap 1024 was sampled twice; both results are shown.*

> At 5000 lights a cap of 1024 drops lights only at peak moments, in at most 3% of the clusters.
> Within the sampled 10 s, 2048 is the smallest power of two that never drops a light.

* The busiest cluster usually holds about 825 lights, 80% of a 1024 cap. The heatmap image above
  shows no full cluster, which fits a typical moment.
* At 2000 lights (cap 1024) the busiest cluster holds 344 lights at the median and 539 at the peak.
  * So a cap of 256 already drops lights at 2000 lights in a typical frame, which matches the blue
    clusters in the first heatmap.
  * A cap of 512 would only be exceeded at peak moments.
  * Both points follow from the cap-1024 readback; I did not read back at cap 256 or 512 with
    2000 lights.

#### Effect on timing

Wall clock from the four sessions that alternated between the two caps (ms, one session per column).

| Lights | F+ 256 | F+ 1024 | F+ 256 | F+ 1024 | D 256 | D 1024 | D 256 | D 1024 |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 500  | 5.9  | 6.0  | 6.0  | 5.9  | 3.1 | 3.1 | 3.1 | 3.1 |
| 1000 | 6.4  | 6.6  | 6.2  | 7.2  | 3.5 | 3.5 | 3.4 | 3.5 |
| 2000 | 12.4 | 12.2 | 12.1 | 12.0 | 6.0 | 6.0 | 6.0 | 5.9 |
| 5000 | 19.5 | 29.2 | 19.5 | 29.6 | 7.0 | 8.9 | 7.9 | 8.7 |

> Up to 2000 lights the cap has no measurable effect on timing. At 5000 lights cap 256 looks much
> faster, but only because a third or more of the non-empty clusters are cut off.

* An earlier pair of sessions showed Forward+ at 500 lights about 1 ms faster with cap 1024. In the
  alternating runs that difference is gone, so it was variation between sessions. Forward+ at very
  low loads also shows two levels with 1 light (see the fixed overhead section), which may be the
  same effect.
* At 5000 lights cap 256 saves Forward+ about 10 ms but Deferred only 0.8 to 1.9 ms. Forward+ walks
  each cluster list about 4x as often per pixel, which explains why it saves more, but not the
  full 5x to 12x difference.
* Even so, the correct Deferred (about 9 ms) is faster than the incorrect Forward+ at cap 256
  (19.5 ms).

Cap 2048 at 5000 lights gives Forward+ 29.0 ms and Deferred 9.0 ms, inside the cap-1024 ranges
(28.0 to 30.5 and 8.4 to 10.0). The few lights that 1024 drops at peak moments have no measurable
effect on timing, so the main table measured at cap 1024 stands. The code uses 1024 by default; 2048
removes the remaining drops at the cost of a 28.3 MB buffer.

## Known limitations

* All measurements use the default camera position. Other views may change the overdraw and the
  cluster load.
* The cluster grid (16 x 9 tiles, 24 slices) was not tuned. At 5000 lights, slices 15 to 23 never
  held a light in any readback sample. A tighter far plane would move those slices to where the
  lights are.
* The cap is fixed per cluster. A compacted index list (a prefix sum over the per-cluster counts)
  would remove it.
* No performance optimization has been measured before and after yet. The depth prepass for
  Forward+ is planned and would also test the 4x lighting ratio.

## Credits

- [Vite](https://vitejs.dev/)
- [loaders.gl](https://loaders.gl/)
- [dat.GUI](https://github.com/dataarts/dat.gui)
- [stats.js](https://github.com/mrdoob/stats.js)
- [wgpu-matrix](https://github.com/greggman/wgpu-matrix)
