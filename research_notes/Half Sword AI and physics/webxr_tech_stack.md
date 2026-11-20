# WebXR Tech Stack for a Physics-Based VR Swordfighting Game (as of Nov 2026)

Researched 2026-11-20. Sources are a mix of primary (GitHub repos, official docs, Meta release notes) and secondary (blogs, forums). Some secondary sources conflict; conflicts are flagged inline. Anything not verified in this session is in Inferences or Gaps, not in Cited Findings.

## Rendering framework: which is best (three.js, Babylon.js, A-Frame, PlayCanvas, r3f/@react-three/xr)?

### Takeaway
three.js (currently r187) with the WebGL2 `WebGLRenderer` is the lowest-risk choice for Quest Browser today. WebXR on `WebGPURenderer` exists (since r185, mid-2026), but WebGPU-in-WebXR on Quest Browser is still marked "experimental" in Meta's own release notes. Babylon.js is the strongest "batteries included" alternative because Havok is first-party, but Havok motors and ragdolls have a documented bug history.

### Cited Findings
- three.js latest release is r187 (`three@0.187.0`, Oct 30 2026). r186 was Sep 8 2026. r185 (Jun 25 2026) "added WebXR on `WebGPURenderer`". r184 lets TSL/node materials run on `WebGLRenderer` through a compatibility layer. r171 (Nov 29 2024) introduced the `three/webgpu` and `three/tsl` entry points — [Utsubo blog, "What's New in Three.js (2026)"](https://www.utsubo.com/blog/threejs-2026-what-changed)
- Older status: three.js maintainers said WebXR was not available on WebGPURenderer and that the only option was its WebGL2 fallback backend (`forceWebGL: true`) — [three.js issue #28968](https://github.com/mrdoob/three.js/issues/28968); [three.js forum: WebGPURenderer VR support](https://discourse.threejs.org/t/webgpurenderer-vr-support/76048)
- The WebXR/WebGPU Binding is an Immersive Web Editor's Draft (dated 15 June 2026). Secondary sources call it experimental as of mid-2026 — [Babylon forum: WebXR/WebGPU Binding](https://forum.babylonjs.com/t/webxr-webgpu-binding/63712); [web3d.org mailing list, Feb 2026](https://web3d.org/pipermail/x3d-ecosystem_web3d.org/2026-February/000800.html)
- Google XR Blocks 0.22.0 (Oct 2026, built on three.js) runs WebGPURenderer only in its desktop simulator, and its spatial UI does not yet work on WebGPURenderer. Real-world WebGPU+XR support in three.js-based frameworks is therefore partial — [mixed-news.com](https://mixed-news.com/en/google-xr-blocks-0-22-0-webgpu-simulator-gemma-4-on-device/); [vr.org, Oct 12 2026](https://vr.org/articles/xr-blocks-0-22-0-webgpu-simulator-spatial-ui-gemma-4-2026)
- Quest Browser (Chromium-based) WebGPU-in-WebXR timeline: Chromium 146 (≈Apr 2026) added experimental WebGPU in WebXR. 149.1 added space-warp layers for WebGPU. 150.1 added experimental foveation for WebGPU in WebXR. 152.1 (Oct 2 2026) added experimental composition layers for WebGPU in WebXR, behind the "webxr experiments" flag in chrome://flags. 146.0 added WebXR depth projection — [Meta Quest Browser release notes](https://developers.meta.com/horizon/documentation/web/browser-release-notes/); [Browser 152.1](https://developers.meta.com/vr/downloads/package/browser/152.1/); [Browser 150.1](https://developers.meta.com/vr/downloads/package/browser/150.1/); [Browser 149.1](https://developers.meta.com/horizon/downloads/package/browser/149.1/); [Browser 146.0](https://developers.meta.com/horizon/downloads/package/browser/146.0/)
- An Oct 14 2026 Quest Browser note adds experimental HTML-in-Canvas hit testing in WebXR and a high-fidelity body tracking flag — [Meta release notes (web)](https://developers.meta.com/horizon/release-notes/web/)
- CONFLICT: a May 2026 vr.org article says WebGPU became Baseline in Jan 2026, that Quest Browser "exposes WebXR through the WebGPU pipeline", and that three.js r171 shipped "in September". The r171 date is wrong (it was Nov 2024 per Utsubo), and the Quest claim contradicts Meta's own "experimental" labels. Treat this article as unreliable — [vr.org, May 6 2026](https://vr.org/articles/webgpu-baseline-2026-three-js-webxr-default)
- WebGPU desktop/mobile support: Chrome/Edge 113+, Chrome Android 121+, Firefox 141+ (Windows), Safari 26 — [Utsubo](https://www.utsubo.com/blog/threejs-2026-what-changed)
- Babylon.js has been WebGPU-capable since 5.0 (2022). Babylon 6.0 introduced the Havok plugin ("Physics V2") — [vr.org](https://vr.org/articles/webgpu-baseline-2026-three-js-webxr-default); [Announcing Babylon.js 6.0](https://forum.babylonjs.com/t/announcing-babylon-js-6-0/40044)
- A-Frame 1.8.0 was released in June 2026 (headline only, not verified in detail) — [vr.org, Jul 1 2026](https://vr.org/articles/aframe-1-8-0-webxr-open-source-june-2026)
- PlayCanvas maintains a page on alternatives to its default ammo.js integration, which signals that ammo.js is no longer the preferred path — [PlayCanvas: Alternatives to ammo.js](https://developer.playcanvas.com/user-manual/physics/ammo-alternatives/)
- Meta's official WebXR samples include three.js-based projects (e.g., Flap Frenzy) — [Meta web sample: Flap Frenzy](https://developers.meta.com/vr/documentation/web/web-sample-flap-frenzy/)

### Inferences
- Recommended: three.js `WebGLRenderer` (WebGL2 + OCULUS_multiview path) for shipping on Quest 2/3. Re-evaluate `WebGPURenderer` once Meta drops the "experimental" label on WebGPU+WebXR. three.js's lightweight scene graph also leaves the physics integration fully up to you, which suits a custom active-ragdoll architecture.
- Babylon.js is a strong alternative if you want an integrated WebXR feature manager (hand tracking, teleport, controller models) and first-party Havok. The cost is a heavier engine and the Havok joint/motor bugs listed below.
- A-Frame (an ECS on top of three.js) adds abstraction overhead, and its physics components are typically cannon/ammo-based. That makes it a poor fit for frame-tight custom physics.
- react-three-fiber / @react-three/xr are fine for UI and tooling, but React reconciliation in the hot path is a risk at 90 Hz. If you use them, keep physics and pose updates outside React state (refs plus `useFrame`). Versions were not verified this session.
- PlayCanvas is a viable editor-centric option, but I found nothing indicating it beats three.js or Babylon for this use case.

### Gaps
- No primary three.js changelog was read for r185 WebXR-on-WebGPU details (multiview support, layers). The Utsubo blog is secondary.
- No current @react-three/xr, @react-three/rapier, or PlayCanvas version numbers were verified.
- No published draw-call or triangle budget for Quest 3 Browser was found in Meta docs this session.

## Physics engines as WASM: motors/PD drives, CCD, multibody, determinism, performance

### Takeaway
Rapier and Jolt are the two credible choices for active ragdolls in the browser. Rapier has PD joint motors on spherical, revolute, and prismatic joints, reduced-coordinate multibody joints, and full or soft CCD. Its JS bindings moved into the main `dimforge/rapier` repo in July 2026. Jolt has a ready-made "Powered Rig" demo (a motor-driven dynamic ragdoll), `Ragdoll`/`RagdollSettings`, multithreaded WASM builds, and a cross-platform-determinism build flag. Havok (via Babylon) is fast and MIT-licensed as a WASM binary, but it is closed source and has a history of motor and ragdoll bugs. Ammo.js and cannon-es are legacy options.

### Cited Findings
**Rapier**
- The `dimforge/rapier.js` repo was archived Jul 12 2026: "This repository has been merged into the main Rapier repository: https://github.com/dimforge/rapier (into the `typescript` directory)" — [GitHub dimforge/rapier.js](https://github.com/dimforge/rapier.js)
- The JS user guide is labeled Rapier JavaScript 0.21 (version per the docs page; the npm version was not directly verified, since npm returned 403). Yarn lists `@dimforge/rapier3d` 0.19.x (0.19.0 dated Sep 2025, "Update to Rapier 0.29.0 … performance improvements for scenes involving a lot of contact constraints"). Rust `rapier3d` is at 0.35/0.36. Soft bodies arrived in Rust Rapier v0.36.0 (Sep 2026) — [Rapier JS joints guide](https://rapier.rs/docs/user_guides/javascript/joints); [Yarn @dimforge/rapier3d](https://classic.yarnpkg.com/en/package/@dimforge/rapier3d); [docs.rs rapier3d 0.35.0](https://docs.rs/crate/rapier3d/0.35.0); [Dimforge blog](https://dimforge.com/blog)
- Joints: fixed, spherical, revolute, and prismatic, plus generic joints. These can be created as impulse joints (`World.createImpulseJoint`) or reduced-coordinate multibody joints (`World.createMultibodyJoint`) — [Rapier JS joints guide](https://rapier.rs/docs/user_guides/javascript/joints)
- Motors: spherical, revolute, and prismatic joints support PD-controller motors through `configureMotorPosition(targetPos, stiffness, damping)`, `configureMotorVelocity(targetVel, damping)`, `configureMotor(targetPos, targetVel, stiffness, damping)`, and `configureMotorModel(model)`. The maximum motor impulse is configurable — [Rapier JS joints guide](https://rapier.rs/docs/user_guides/javascript/joints)
- CCD: per-body `setCcdEnabled(true)` / `enableCcd(true)`. Fast dynamic bodies are automatically swept against fixed colliders even without CCD. CCD-enabled bodies are also swept against dynamic and kinematic bodies, which costs more. `IntegrationParameters.maxCcdSubsteps` defaults to 1. Soft CCD (`setSoftCcdPrediction(distance)`) adds predictive contacts as a cheaper option for thin or fast objects, but large values hurt performance — [Rapier JS rigid bodies guide](https://rapier.rs/docs/user_guides/javascript/rigid_bodies)
- Kinematic position-based bodies (`setNextKinematicTranslation/Rotation`) derive their velocity from target poses, so dynamic bodies react realistically. They ignore contact forces. Dominance groups range over [-127, 127], and per-body `setAdditionalSolverIterations(n)` adds solver iterations — [Rapier JS rigid bodies guide](https://rapier.rs/docs/user_guides/javascript/rigid_bodies)
- In a native Godot comparison (not a browser test), Rapier3D was fastest in 3 of 5 scenes, 4x ahead on queries, and "Jolt crashes the joint grid" (Jolt v5.5.0 in Godot 4.7) — [Godot forum comparison](https://forum.godotengine.org/t/physics-engine-comparison-rapier-vs-godot-vs-box2d-3d-vs-jolt/142786)

**Jolt (JoltPhysics.js)**
- MIT license. Build flavours: `wasm`, `wasm-compat`, `asm`, `wasm-multithread`, `wasm-compat-multithread`, plus debug variants. SIMD is on by default in the multithreaded builds. `-DCROSS_PLATFORM_DETERMINISTIC=ON` makes results match the native library. Objects must be freed manually (`new Jolt.X` / AddRef/Release) — [GitHub jrouwe/JoltPhysics.js](https://github.com/jrouwe/JoltPhysics.js)
- Exposes `RagdollSettings`/`Ragdoll`. Demos include "Powered Rig" (dynamic ragdoll driven by motors playing an animation), "Kinematic Rig", "Constraint Motor Demo", a constraints demo, and single- and multi-threaded stress tests — [JoltPhysics.js demos](https://jrouwe.github.io/JoltPhysics.js/)

**Havok (@babylonjs/havok)**
- The npm package is MIT-licensed. The engine itself is closed source ("the .wasm usage is MIT"), with little documentation outside Babylon — [npm @babylonjs/havok](https://www.npmjs.com/package/@babylonjs/havok); [Babylon forum: Havok license](https://forum.babylonjs.com/t/havok-with-babylon-js-license-free-to/59637); [three.js forum: Havok for three](https://discourse.threejs.org/t/anyone-used-the-havok-physics-engine-for-three/53205)
- Motors support position or velocity targets with a max force on 6DoF constraints. Known bugs: `HavokPlugin.setAxisMotorType()` passed the wrong enum to the WASM (later fixed). A position motor doesn't reach its target angle on a hinge. A position-mode motor with a custom rotation axis was confirmed buggy by a maintainer — [Havok motorized constraints](https://forum.babylonjs.com/t/havok-motorized-constraints/40415); [Position motor does not reach target](https://forum.babylonjs.com/t/position-motor-does-not-reach-target-angle/61388); [Custom axis bug](https://forum.babylonjs.com/t/physics-motor-joints-with-position-mode-cant-use-a-custom-rotation-axis/62657)
- Babylon's ragdoll helper was reported "not really usable" in 6.48.1 (meshes disappearing, no cone joint; 6DoF suggested as a workaround). Users also ask about making Havok joints more rigid — [Issues with Ragdolls (physics v2)](https://forum.babylonjs.com/t/issues-with-ragdolls-physics-v2/49090); [Making Havok joints more rigid](https://forum.babylonjs.com/t/making-havok-joints-more-rigid/53879)
- One user reported 3000 entities at 60 fps single-threaded in a Havok benchmark page (anecdotal) — [Babylon forum: Havok benchmark](https://forum.babylonjs.com/t/havok-physics-benchmark-multithreading-question/49009)

**Cross-engine performance (anecdotal only)**
- The forum benchmarks conflict. One user reported 300 cubes at Rapier 40 fps / Jolt 20 fps / Ammo 5 fps. Another reported 400 boxes at Ammo 60 / Jolt 30 / Rapier 60. Neither documented their setup — [three.js forum: which engine](https://discourse.threejs.org/t/which-physics-engine-is-prefered-in-this-case/73956); [Rapier vs cannon](https://discourse.threejs.org/t/rapier-vs-cannon-performance/53475)
- cannon: 300 cubes at 45–60 fps (anecdote) — [three.js forum](https://discourse.threejs.org/t/rapier-vs-cannon-performance/53475)
- A community sandbox compares Havok, Ammo, Oimo, PhysX, and Rapier side by side (results not verified) — [three.js forum: selecting physics engine](https://discourse.threejs.org/t/selecting-physics-engine/60344)

### Inferences
- **Primary recommendation: Rapier (rapier3d-compat or the SIMD build) with three.js.** It is the best-documented JS API, has PD motors on spherical joints (one drive per ragdoll joint), and offers multibody joints. Multibody joints are reduced-coordinate and therefore stiffer and more stable for long chains such as the arm→sword chain. It is also deterministic within the same WASM build. Jolt is the main alternative: its Powered Rig demo is the closest off-the-shelf active-ragdoll proof, and its multithreaded build may scale better. Its downsides are manual memory management and an auto-generated, C++-mirroring API.
- From prior knowledge, not re-verified this session:
  - Rapier's WASM is cross-platform deterministic for the same build and inputs (IEEE-754, no SIMD-dependent non-determinism in the non-SIMD build).
  - Ammo.js is effectively unmaintained.
  - cannon-es lacks real CCD and has only simple hinge motors.
  - PhysX WASM (`physx-js-webidl`) exists, but its builds are large and its community is thin.
  - Verify all of these before relying on them.
- Sword collisions: use a dynamic sword with CCD enabled (or soft CCD with a prediction distance of about blade-tip speed × dt), a capsule or convex-hull blade collider (not a trimesh, since mesh shapes are excluded from automatic sweeping), and the substepping described in the next section.
- Body/joint budget on Quest: there is no reliable public number. Rough engineering estimate: 2 ragdolls × ~15–20 bodies/joints, plus props, is the safe envelope at 90 Hz with 2–4 substeps in a worker on Quest 3. This must be profiled.

### Gaps
- No rigorous browser (let alone Quest) benchmark of Rapier vs Jolt vs Havok was found. The forum numbers are contradictory and undocumented.
- Exact current npm versions of `@dimforge/rapier3d(-compat)` and `jolt-physics` could not be verified (npm returned 403). The rapier.js tags were not inspected.
- The Rapier `MotorModel` names (AccelerationBased/ForceBased) and whether multibody joint motors are exposed in JS were not confirmed from the JS docs page.
- Havok's current CCD capabilities in the web build were not found.
- PhysX-WASM and Ammo.js maintenance status was not verified this session.

## Physics in a Web Worker / SharedArrayBuffer, fixed timestep and substepping, latency

### Takeaway
Running physics in a worker is feasible: both Rapier and Jolt run in workers, and Jolt ships a multithreaded build. A worker adds about one frame of latency for hand-held weapons unless the hand/sword target is applied in the same frame. Quest Browser's SharedArrayBuffer status was not confirmed.

### Cited Findings
- Jolt ships `-multithread` WASM builds and a multithreaded stress-test demo. Multithreaded WASM requires SharedArrayBuffer and therefore cross-origin isolation (COOP/COEP headers) — [JoltPhysics.js README](https://github.com/jrouwe/JoltPhysics.js); [Jolt demos](https://jrouwe.github.io/JoltPhysics.js/)
- Meta recommends staggering non-critical updates across frames (e.g., animation at 30 Hz while rendering at 90 Hz; updating a third of objects each frame) when CPU-bound — [Meta WebXR perf best practices](https://developers.meta.com/horizon/documentation/web/webxr-perf-bp/)
- Rapier's kinematic position-based bodies take a "next" pose each step and infer velocity from it, which is the standard way to drive a tracked hand/weapon proxy — [Rapier rigid bodies guide](https://rapier.rs/docs/user_guides/javascript/rigid_bodies)

### Inferences
- Recommended architecture: simulate in a dedicated worker at a fixed rate equal to the display rate or a multiple of it (90 Hz with 2–4 substeps = 180–360 Hz effective), with snapshot transforms in a SharedArrayBuffer (Float32 pose array) read by the render thread. Fall back to `postMessage` with transferable ArrayBuffers if cross-origin isolation is unavailable.
- Latency mitigation for the held sword: do NOT make the sword kinematic (it would pass through blocks). Drive a kinematic "hand target" body each step from the latest predicted controller pose, and connect the dynamic sword/hand to it with a strong PD joint (motor or 6DoF spring). Render the hand at the tracked pose and the sword at its physics pose. This is the standard "physics hands" pattern (Boneworks/Blade & Sorcery style).
- If physics runs on the main thread instead, step inside the XR `requestAnimationFrame` callback using that frame's `XRFrame.getPose()` (already predicted to display time). This minimizes latency at the cost of main-thread budget.
- Interpolate render transforms between physics steps when the physics rate isn't locked to the display rate.

### Gaps
- No source confirmed whether Quest Browser supports `crossOriginIsolated`/SharedArrayBuffer for WASM threads, or how much worker overhead it adds.
- No measured latency figures for worker-based physics in WebXR were found.
- No Rapier JS docs on the substep API (`numSolverIterations`, `numInternalPgsIterations`) were captured this session.

## WebXR specifics: pose prediction, haptics, frame budget, foveation, hand tracking

### Takeaway
Quest Browser supports `GamepadHapticActuator.pulse()` (widely used, but with a past left/right routing bug), fixed foveation (smooth since browser 36, with WebGPU foveation still experimental in 150.1), and targets of 72/90 Hz. At 90 Hz the frame budget is ~11.1 ms and is shared by JS, physics, and rendering.

### Cited Findings
- Haptics: `Gamepad.hapticActuators[i].pulse(intensity, durationMs)` is the WebXR controller haptics path. Quest Browser implemented `pulse` and it "is widely used by WebXR experiences", which is the stated reason it wasn't removed from the spec. The newer `vibrationActuator.playEffect()` is a separate API — [MDN pulse()](https://developer.mozilla.org/en-US/docs/Web/API/GamepadHapticActuator/pulse); [MDN hapticActuators](https://developer.mozilla.org/docs/Web/API/Gamepad/hapticActuators); [W3C public-webapps-github, 2023](https://lists.w3.org/Archives/Public/public-webapps-github/2023Nov/0318.html)
- Known bug: on Quest Browser v2.1.1034, vibrating the right controller vibrated the left, and vibrating the left did nothing. Meta marks it "Fix complete" — [Meta feedback](https://developers.meta.com/horizon/feedback/vr/investigations/938861405320634/); [Meta community forum](https://communityforums.atmeta.com/discussions/OtherTroubleshooting/browser-webxr-controller-vibration-bug-after-updating-to-os-v2-1/1368669)
- Quest Pro controllers have 3 haptic actuators (grip, thumb rest, trigger) — [Meta: WebXR Pro controller](https://developers.meta.com/vr/documentation/web/webxr-pro-controller/)
- Fixed foveation: requested at session start (e.g., the `high-fixed-foveation-level` feature) or at runtime via `XRWebGLLayer.fixedFoveation` (0–1). Since browser 36.0, foveation scales smoothly. Meta warns that high-contrast or text scenes show artifacts — [Meta WebXR FFR](https://developers.meta.com/horizon/documentation/web/webxr-ffr/)
- NVIDIA's CloudXR.js guide (third party) suggests `framebufferScaleFactor` 1.4–1.5 as a high-quality range on Quest-class devices, and foveation of 0.666 as a medium default — [NVIDIA CloudXR.js performance](https://docs.nvidia.com/cloudxr-sdk/latest/usr_guide/cloudxr_js/performance.html)
- Meta's perf workflow: first determine whether the app is CPU- or GPU-bound (e.g., by rendering nothing), change one thing at a time, and test on device. The default frame rate is 72 FPS on Quest 1 and 90 on Quest 2 — [Meta WebXR perf workflow](https://developers.meta.com/horizon/documentation/web/webxr-perf-workflow/)
- GPU guidance: render opaque objects front-to-back, minimize overdraw and transparency, use KTX2/Basis textures, keep to one directional or point light with PBR, avoid point-light shadows (6 shadow maps per light), and clear to black or white (Adreno fast clear) — [Meta WebXR perf best practices](https://developers.meta.com/horizon/documentation/web/webxr-perf-bp/)
- Body tracking: Quest Browser (Oct 2026) added a flag for high-fidelity body tracking in WebXR — [Meta release notes](https://developers.meta.com/horizon/release-notes/web/)
- Haptics over Quest Link on desktop Chrome has had problems (forum thread) — [Babylon forum: haptics over Link](https://forum.babylonjs.com/t/how-to-get-haptics-working-with-webxr-on-quest-3-over-link-cable/62696)

### Inferences
- Frame budget: 1000/90 ≈ 11.1 ms (13.9 ms at 72 Hz, 8.3 ms at 120 Hz). Plan for roughly 3–4 ms of physics (ideally off-thread), with the rest for render submission and game logic.
- Pose prediction: WebXR poses from `XRFrame.getPose(gripSpace, refSpace)` are already predicted by the runtime to the frame's display time, so don't add your own prediction. Controller linear and angular velocity is available via `XRPose.linearVelocity`/`angularVelocity` where supported. Use it to seed kinematic hand velocities for strike damage.
- Hand tracking (the `hand-tracking` feature, 25 joints per hand) is a poor fit for sword gripping because it has no haptics and occlusion breaks tracking. Make controllers the primary input.
- Use `pulse()` scaled by impact impulse for clash and hit feedback. Short (10–40 ms) pulses at varied intensity can approximate texture.

### Gaps
- No Meta doc numbers were found for Quest 3 Browser CPU/GPU budgets, draw-call limits, or 120 Hz availability in WebXR.
- `XRPose.linearVelocity` support on Quest Browser was not verified this session.
- No Quest-specific WebXR hand-tracking latency data was found.

## Existing open-source examples (active ragdolls / physics melee in the browser)

### Takeaway
Nothing complete exists for VR active-ragdoll swordfighting in the browser. The closest pieces are the Jolt "Powered Rig" demo (motor-driven ragdoll), etcGrab Cube (three.js + Rapier active ragdoll + WebXR), Knight's Waltz (three.js + Rapier physics sword dueling, 2D), and mattvb91's three.js + Rapier ragdoll.

### Cited Findings
- Jolt "Powered Rig": a dynamic ragdoll driven by motors that tracks an animation, running in the browser — [JoltPhysics.js demos](https://jrouwe.github.io/JoltPhysics.js/)
- etcGrab Cube (`Sami9889/hand-grab-cube`): three.js + Rapier.js (or cannon) active ragdoll with an "Enter VR" WebXR bridge, live at hand-grab-cube.sami-s.dev — [Medium write-up](https://medium.com/@sami9889/beyond-the-headset-engineering-etcgrab-cube-for-browser-based-spatial-computing-ca11ed596166)
- Knight's Waltz (`saomin0317/knight-duel`, GPL-3.0): a top-down sword duel with three.js + `rapier2d-compat`. Swords have mass and inertia, damage comes from the relative velocity at the blade contact point, shields physically block, stamina limits spinning, and limbs can be severed by re-parenting a mesh to a new rigid body. The author found that "sword feel" tuning took far more iteration than rendering — [three.js forum: Knight's Waltz](https://discourse.threejs.org/t/knights-waltz-a-top-down-physics-sword-dueling-game-three-js-rapier-no-game-engine/93523)
- mattvb91 rapierjs-ragdoll: a passive three.js + Rapier ragdoll with a live demo — [DEV.to: Realistic ragdoll physics in three.js](https://dev.to/mattvb91/realistic-ragdoll-physics-in-threejs-1pko)
- VRragdoll (vivido-design.com): VR, a Rapier NPC, and body IK. Shown on the three.js forum, with no source found — [three.js forum search result](https://discourse.threejs.org/t/active-ragdoll-physics/67247)
- The three.js forum "Active Ragdoll Physics" thread covers only cannon.js examples (the classic cannon ragdoll demo, and Mixamo bones driving a cannon sphere on r125). It has no motor or balance implementation — [three.js forum: Active Ragdoll Physics](https://discourse.threejs.org/t/active-ragdoll-physics/67247); [cannon.js ragdoll demo](https://schteppe.github.io/cannon.js/demos/ragdoll.html)
- Babylon ragdoll (Physics V2) has had usability issues — [Babylon forum](https://forum.babylonjs.com/t/issues-with-ragdolls-physics-v2/49090)
- Itch.io active-ragdoll demos (incl. "Active Ragdoll Player System for VR") exist, but appear to be native or engine builds, not web — [itch: Active Ragdoll Player System for VR](https://physicsproject11.itch.io/active-ragdoll-player-system-for-vr)

### Inferences
- The fastest prototype path: port Jolt's Powered Rig approach (animation pose → per-joint motor targets) to Rapier spherical-joint `configureMotorPosition`, or use Jolt directly. Add physics-hands sword coupling (kinematic target + PD joint) and take the damage model from Knight's Waltz (relative contact velocity).

### Gaps
- No open-source browser VR melee game with active ragdoll enemies was found.
- The source code of etcGrab Cube and VRragdoll was not reviewed. Their motor and balance methods are unknown.
