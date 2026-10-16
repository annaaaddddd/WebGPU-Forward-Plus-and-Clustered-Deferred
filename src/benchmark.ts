import { canvas, device, setFrameTimeListener, PassTiming } from './renderer';
import { Lights } from './stage/lights';
import { Camera } from './stage/camera';
import { constants } from './shaders/shaders';

// usage: run `await benchmark()` in the browser console, keep the camera still and the tab visible
// the whole sweep repeats for a few rounds so clock drift hits every mode about the same
// each csv row records canvas size and cap since both change the timings
//
// other helpers:
//   printCamera()                                                    prints the current camera pose
//   await benchmark({ view: 'name', camera: { pos, yaw, pitch } })   runs the sweep from that pose
//   await clusterStats({ numLights: 5000, frames: 20 })              reads back the cluster buffer

type Sample = { ms: number, passes: PassTiming[] };

// one csv column per pass label
const PASS_COLUMNS = ['clustering', 'prepass', 'mark', 'render', 'gbuffer', 'fullscreen'];

export function setupBenchmark(lights: Lights, camera: Camera, setRenderer: (mode: string) => void) {
    let sink: ((s: Sample) => void) | undefined;
    const sample = (n: number) => new Promise<Sample[]>(resolve => {
        const samples: Sample[] = [];
        sink = s => {
            samples.push(s);
            if (samples.length === n) {
                sink = undefined;
                resolve(samples);
            }
        };
    });

    const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
    const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length;

    // median gpu time of one pass, '' if the pass didn't run
    const passMedian = (samples: Sample[], label: string) => {
        const v = samples.map(s => s.passes.find(p => p.label === label)?.ms).filter((x): x is number => x !== undefined);
        return v.length ? median(v).toFixed(3) : '';
    };
    const gpuTotalMedian = (samples: Sample[]) => {
        const v = samples.filter(s => s.passes.length > 0).map(s => s.passes.reduce((a, p) => a + p.ms, 0));
        return v.length ? median(v).toFixed(3) : '';
    };

    (window as any).printCamera = () => {
        const p = camera.getPose();
        console.log(`camera: { pos: [${p.pos.map(x => x.toFixed(2)).join(', ')}], yaw: ${p.yaw.toFixed(1)}, pitch: ${p.pitch.toFixed(1)} }`);
        return p;
    };

    (window as any).benchmark = async ({
        lightCounts = [500, 1000, 2000, 5000],
        modes = ['naive', 'forward+', 'forward+ prepass', 'forward+ prepass cull', 'clustered deferred', 'clustered deferred cull'],
        rounds = 3,
        frames = 200,
        warmup = 30,
        view = 'default',
        camera: pose = undefined as { pos: [number, number, number], yaw: number, pitch: number } | undefined,
        // warm: run naive at 5000 lights for a few frames first so the gpu clock is up
        warm = false,
        warmFrames = 6,
        // print a wall-clock stamp per configuration, to line the run up with an nvidia-smi log
        logTimes = false
    } = {}) => {
        // debug views skip the lighting loop, which makes the timings meaningless
        if (constants.clusterDebugMode !== 0) {
            throw new Error(`benchmark aborted: clusterDebugMode is ${constants.clusterDebugMode}, set it to 0 in shaders.ts`);
        }

        if (pose) {
            camera.setPose(pose.pos, pose.yaw, pose.pitch);
        }
        const p = camera.getPose();
        console.log(`benchmark: canvas ${canvas.width}x${canvas.height}, clusters ${constants.clusterDimX}x${constants.clusterDimY}x${constants.clusterDimZ}, maxLightsPerCluster ${constants.maxLightsPerCluster}, ` +
            `view "${view}" (pos [${p.pos.map(x => x.toFixed(2)).join(', ')}], yaw ${p.yaw.toFixed(1)}, pitch ${p.pitch.toFixed(1)})`);

        setFrameTimeListener((ms, passes) => sink?.({ ms, passes }));

        const rows = ['round,mode,numLights,view,warm,canvasWidth,canvasHeight,clusterDimX,clusterDimY,clusterDimZ,maxLightsPerCluster,frames,mean_ms,median_ms,'
            + PASS_COLUMNS.map(c => `gpu_${c}_ms`).join(',') + ',gpu_total_ms'];
        const perConfig = new Map<string, { mode: string, count: number, medians: number[] }>();

        for (let round = 1; round <= rounds; round++) {
            for (const count of lightCounts) {
                for (const mode of modes) {
                    if (warm) {
                        // heavy load first: naive at 5000 lights takes about 350 ms per frame
                        lights.numLights = Lights.maxNumLights;
                        lights.updateLightSetUniformNumLights();
                        setRenderer('naive');
                        await sample(warmFrames);
                    }

                    lights.numLights = count;
                    lights.updateLightSetUniformNumLights();
                    setRenderer(mode);
                    if (logTimes) {
                        console.log(`benchmark: ${new Date().toTimeString().slice(0, 8)} round ${round} ${mode} ${count}`);
                    }

                    await sample(warmup);
                    const samples = await sample(frames);
                    const times = samples.map(s => s.ms);

                    const m = median(times);
                    rows.push(`${round},${mode},${count},${view},${warm ? 1 : 0},${canvas.width},${canvas.height},${constants.clusterDimX},${constants.clusterDimY},${constants.clusterDimZ},${constants.maxLightsPerCluster},${frames},`
                        + `${mean(times).toFixed(3)},${m.toFixed(3)},`
                        + PASS_COLUMNS.map(c => passMedian(samples, c)).join(',') + `,${gpuTotalMedian(samples)}`);

                    const key = `${mode}|${count}`;
                    if (!perConfig.has(key)) {
                        perConfig.set(key, { mode, count, medians: [] });
                    }
                    perConfig.get(key)!.medians.push(m);
                }
            }
            console.log(`benchmark: round ${round}/${rounds} done`);
        }

        setFrameTimeListener(undefined);

        console.table([...perConfig.values()].map(c => ({
            mode: c.mode,
            numLights: c.count,
            median_ms: +median(c.medians).toFixed(3),
            min_ms: +Math.min(...c.medians).toFixed(3),
            max_ms: +Math.max(...c.medians).toFixed(3)
        })));

        const csv = rows.join('\n');
        console.log(csv);
        return csv;
    };

    // reads back the cluster buffer and reports how full the clusters are, overall and per slice
    // samples are spread out since the lights keep moving
    // mode picks the renderer, cull modes also read back the active flags
    (window as any).clusterStats = async ({
        numLights = lights.numLights,
        frames = 10,
        warmup = 30,
        intervalMs = 500,
        mode = 'forward+'
    } = {}) => {
        const cap = constants.maxLightsPerCluster;
        const numClusters = constants.numClusters;
        const sliceSize = constants.clusterDimX * constants.clusterDimY;
        const stride = 1 + cap; // numLights + cap indices
        const byteLength = numClusters * stride * 4;

        const staging = device.createBuffer({
            label: "cluster readback",
            size: byteLength,
            usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST
        });
        const flagsStaging = device.createBuffer({
            label: "active cluster flags readback",
            size: numClusters * 4,
            usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST
        });

        lights.numLights = numLights;
        lights.updateLightSetUniformNumLights();
        setRenderer(mode);
        setFrameTimeListener((ms, passes) => sink?.({ ms, passes }));
        await sample(warmup);

        type FrameStats = { nonEmpty: number, full: number, max: number, meanNonEmpty: number, active: number,
                            sliceMax: number[], sliceFull: number[], sliceActive: number[] };
        const perFrame: FrameStats[] = [];
        let lastSample = -Infinity;
        for (let f = 0; f < frames; f++) {
            // copy the cluster buffer once a frame is done and enough time has passed
            await new Promise<void>(resolve => {
                sink = () => {
                    if (performance.now() - lastSample < intervalMs) {
                        return; // keep rendering until the next sample is due
                    }
                    lastSample = performance.now();
                    sink = undefined;
                    const encoder = device.createCommandEncoder();
                    encoder.copyBufferToBuffer(lights.clusterSetStorageBuffer, 0, staging, 0, byteLength);
                    encoder.copyBufferToBuffer(lights.clusterActiveBuffer, 0, flagsStaging, 0, numClusters * 4);
                    device.queue.submit([encoder.finish()]);
                    resolve();
                };
            });
            await Promise.all([staging.mapAsync(GPUMapMode.READ), flagsStaging.mapAsync(GPUMapMode.READ)]);
            const data = new Uint32Array(staging.getMappedRange());
            const flags = new Uint32Array(flagsStaging.getMappedRange());

            const stats: FrameStats = {
                nonEmpty: 0, full: 0, max: 0, meanNonEmpty: 0, active: 0,
                sliceMax: new Array(constants.clusterDimZ).fill(0),
                sliceFull: new Array(constants.clusterDimZ).fill(0),
                sliceActive: new Array(constants.clusterDimZ).fill(0)
            };
            let sum = 0;
            for (let c = 0; c < numClusters; c++) {
                const n = data[c * stride];
                const z = Math.floor(c / sliceSize);
                if (flags[c] != 0) { stats.active++; stats.sliceActive[z]++; }
                if (n > 0) { stats.nonEmpty++; sum += n; }
                if (n >= cap) { stats.full++; stats.sliceFull[z]++; }
                if (n > stats.max) { stats.max = n; }
                if (n > stats.sliceMax[z]) { stats.sliceMax[z] = n; }
            }
            stats.meanNonEmpty = stats.nonEmpty > 0 ? sum / stats.nonEmpty : 0;
            staging.unmap();
            flagsStaging.unmap();
            perFrame.push(stats);
        }

        setFrameTimeListener(undefined);
        staging.destroy();
        flagsStaging.destroy();

        const med = (pick: (s: FrameStats) => number) => median(perFrame.map(pick));
        const peak = (pick: (s: FrameStats) => number) => Math.max(...perFrame.map(pick));
        const summary = {
            mode,
            numLights,
            cap,
            frames,
            intervalMs,
            clusters: numClusters,
            activeClusters: med(s => s.active), // 0 unless the mode culls
            nonEmptyClusters: med(s => s.nonEmpty),
            fullClusters: med(s => s.full),
            fullClustersPeak: peak(s => s.full),
            maxLights: med(s => s.max),
            maxLightsPeak: peak(s => s.max),
            meanLightsNonEmpty: +med(s => s.meanNonEmpty).toFixed(1)
        };
        console.table([summary]);

        const sliceDepth = (z: number) => Camera.nearPlane * Math.pow(Camera.farPlane / Camera.nearPlane, z / constants.clusterDimZ);
        console.table(Array.from({ length: constants.clusterDimZ }, (_, z) => ({
            slice: z,
            depthNear: +sliceDepth(z).toFixed(2),
            depthFar: +sliceDepth(z + 1).toFixed(2),
            activeClusters: med(s => s.sliceActive[z]),
            maxLights: med(s => s.sliceMax[z]),
            fullClusters: med(s => s.sliceFull[z])
        })));

        console.log('mode,numLights,cap,frames,intervalMs,clusters,activeClusters,nonEmptyClusters,fullClusters,fullClustersPeak,maxLights,maxLightsPeak,meanLightsNonEmpty\n'
            + [summary.mode, summary.numLights, summary.cap, summary.frames, summary.intervalMs, summary.clusters, summary.activeClusters,
               summary.nonEmptyClusters, summary.fullClusters, summary.fullClustersPeak, summary.maxLights, summary.maxLightsPeak,
               summary.meanLightsNonEmpty].join(','));
        return summary;
    };
}
