# Half Sword Enemy AI and AI for Physically Simulated Melee Opponents

Research date: 2026-11-20. Primary sources: the official Steam announcement feed for Half Sword (app 2397300, pulled through the Steam News API: 70 posts from 2024-07 to 2026-11-17), the original developer's comments on the itch.io demo page, Steam player discussions, and the Won et al. 2021 SIGGRAPH paper (full text read). Labels used: **[CONFIRMED]** means a developer or primary source says it. **[PLAYER REPORT]** is anecdotal. **[SPECULATION]** is my inference.

Timeline context: Itch.io tech demo in 2022. Steam playtests from 2024-07. On 2025-04-02 the playtest and demo were merged and Gauntlet Mode was added. Early Access launched 2026-01-30. 0.6.1 (2026-06-20) brought the "Active Ragdoll Total Overhaul" and "Better AI". 0.7 "The Crypts" (2026-11-10) brought the new "Combat Behavior" and "Social Behavior" AI systems, followed by hotfixes up to 0.7.0.3 (2026-11-17). Engine: Unreal Engine 5. Developer: Half Sword Games (Georgia), about 10 people. — [Wikipedia](https://en.wikipedia.org/wiki/Half_Sword); [Steam news feed](https://store.steampowered.com/news/app/2397300)

## Q1: Does Half Sword's AI use scripted attack trajectories, procedural targeting, or learned policies?

### Takeaway
Nothing points to learned (ML/RL) policies. The developer describes the body as entirely procedural: a hidden, non-simulated animation skeleton driven by Two-Bone IK, which a physically simulated ragdoll follows through joint motors. NPCs "use the same functions as the player", so the AI most likely produces procedural hand and weapon targets and stances, and physics carries them out. The decision layer is a hand-authored sense-and-react system that was rebuilt several times (0.6.1, 0.6.1.3, 0.6.1.4, 0.7) and that the developers themselves call 75% done.

### Cited Findings
- **Body control (developer, itch.io demo era, about 2022) [CONFIRMED]:**
  - The developer says "I have this weird system where I have a hidden skeleton, which is not simulated and plays Anim BP", and the physical body "adjusts it's position by joint motors". He advises against SLERP drive.
  - "All the animations are done procedurally here (so no keyframe animations for arms/legs)" and "I am also using exclusively Two Bone IK for every limb".
  - Feet: "before every step I trace the land at the location where I want foot to step on".
  - Root/balance trick: "I connect pelvis of the mesh to the collision capsule by a physics constraint… set all the limits to free and use linear and angular motor to keep the body in place and upright… constantly change the values of those motors powers so that result looks natural". The capsule is not allowed "to travel too far from character mesh".
  - On weapon handling he said "I need to change muscle power of the character", meaning motor strength is the "muscle" parameter.
  - Source for all of the above: [knives-frank itch.io comments](https://knives-frank.itch.io/halfsword/comments?after=0)
- **Possibly superseded [CONFIRMED that the rig changed]:** 0.6.1 (2026-06-20) brought an "Active Ragdoll Total Overhaul". The developer wrote that it "Massively optimized ragdolls and rebuilt the whole structure from the ground up… I made this system years ago… was too performance-heavy. Now it is twice as good performance-wise". The same patch made wrists "more rigid so that your weapons flop less" and reworked the procedural animations to allow cuts "from more angles". The current rig internals were not described. — [Steam: Update 0.6.1 Patch Notes](https://store.steampowered.com/news/app/2397300) (2026-06-20)
- **Official framing of procedural animation [CONFIRMED]:** "The player model operates as a unified dynamic physics system. Every new procedural animation such as grips, stances, or damage reactions introduces new variables that must be tested and rebalanced." — [Steam: Addressing Common Feedback](https://store.steampowered.com/news/app/2397300) (2026-03-19)
- **0.7 AI description [CONFIRMED]:** "Combat Behavior (work in progress, 75%) NPCs are much more aware now and will react to combat situations based on their senses. They see threats in front of them, they know where their weapons are, where opponents's weapons are and try to act accordingly. They still make mistakes (especially on lower ranks)… Group coordination is still being worked on." — [Steam: Half Sword 0.7: The Crypts Update](https://store.steampowered.com/news/app/2397300) (2026-11-10)
- **0.7 Social Behavior [CONFIRMED]:** The patch says "(new feature being worked on, 25%) NPCs have emotions and personalities now". It describes vision and hearing perception that depend on lighting and visibility: "golden armor under direct sunlight" is noticed more easily than "someone laying in a dark corner while wearing all black". It also mentions NPC-to-NPC communication, "mostly in a violent manner", and robbing and looting. Gestures are planned. — same post
- **Earlier AI iterations [CONFIRMED]:**
  - 0.6.1: "Better AI. AI is more responsive and aggressive now. Next, they will learn how to fight in groups."
  - 0.6.1.1: "Less equipped characters are much less likely to rush a better equipped opponent", which points to a gear-comparison aggression heuristic.
  - 0.6.1.3: "AI self preservation should be better. They will still aggressively push you but the will parry, riposte, sidestep and back step more often."
  - 0.6.1.4 hotfix: "Reworked AI again, should be even more responsive and fun".
  - 0.6.1.5: "Enemies grab less often… Ai tweaks".
  - Source for all of the above: [Steam news](https://store.steampowered.com/news/app/2397300)
- **0.7 weapon use [CONFIRMED]:** "AI can and will use crossbows. Pitchforks, Rakes, Scythes were also added to NPCs arsenal." — [Steam 0.7](https://store.steampowered.com/news/app/2397300)
- **Modding [CONFIRMED that a toggle exists]:** The community "Half Sword Enhancer" mod offers a "Toggle Enemy AI" option. — [Nexus Mods](https://www.nexusmods.com/halfsword/mods/26)

### Inferences
- [SPECULATION, strong] The AI probably drives NPCs through the same input abstraction as the player. A player's mouse moves a weapon/hand target in a plane plus grip and stance modes, the procedural IK skeleton turns that into a pose, and the motors follow it. An NPC's "attack" is then probably a procedurally generated hand-target path toward an opponent body part, not a mocap clip. A player report supports this: a "pre-swing pose" followed by an instant "arm snap" with irregular timing ([Steam thread, 2023](https://steamcommunity.com/app/2397300/discussions/0/4038101970213132152/)). That pattern looks like "move to windup target, then set strike target", with physics doing the interpolation.
- [SPECULATION] The words "senses", "they know where … weapons are" and the percent-complete language read like a hand-built perception plus state or utility system, likely UE Behavior Trees/StateTree with EQS-style checks. No source names the framework.
- No source anywhere suggests reinforcement learning or other learned policies.

### Gaps
- No developer interview or talk describing the AI architecture (BT, utility, FSM) was found. The Epic Games Store feature article "How Half Sword makes bloody brutal medieval combat feel real" returned 403 and could not be read. The 2024 "Dev Q&A With Frank & Ivan" Steam post is image-only.
- No confirmation of whether the 2022 hidden-skeleton/Two-Bone-IK design survived the 0.6.1 ragdoll rebuild.

## Q2: How does it read the player's weapon to block/parry?

### Takeaway
Officially, only since 0.7 (Nov 2026) do NPCs explicitly track their own and their opponent's weapon positions and "see threats in front of them". Before that, players widely reported that AI defense was weak or absent and that fights came down to "hitting first". Parry and riposte behaviour was added as a self-preservation tweak in 0.6.1.3.

### Cited Findings
- 0.7: "They see threats in front of them, they know where their weapons are, where opponents's weapons are and try to act accordingly." — [Steam 0.7](https://store.steampowered.com/news/app/2397300)
- 0.6.1.3 added more parry, riposte, sidestep and back-step (quoted above). — [Steam news](https://store.steampowered.com/news/app/2397300)
- [PLAYER REPORT, Nov 2023 demo] "Defense is completely pointless, it's just about hitting first." Another player said AI is "simply there to swing their weapon without any direction". On the other hand, "the bots are really good at casually holding a sword or even an axe right at your face", meaning the blade held in line works as a passive guard. Hitting the enemy's weapon can "stun their swing". — [Steam: AI attack behaviour is frustrating](https://steamcommunity.com/app/2397300/discussions/0/4038101970213132152/)
- [PLAYER REPORT, July 2026 EA] "AI in EA is really dumb they barely even dodge, parry, back away" and rarely react to changes of guard or grip. Others saw enemies stay about "3 feet back and keep dodging", swinging mainly after the player had attacked. Several players said the demo AI was better. — [Steam: AI just run at you, halfswording](https://steamcommunity.com/app/2397300/discussions/0/590684692649472658/)
- A Gauntlet guide tip: hold "your weapon in line with your opponent and charging, which is far easier in a half-sword stance". This suggests that a held point line beats the AI. — via search summary of [Steam discussions](https://steamcommunity.com/app/2397300/discussions/0/597398871354645874)

### Inferences
- [SPECULATION] A plausible 0.7 mechanism is a per-tick threat query. For each opponent weapon, take its tip and edge position and velocity, project it onto the NPC's body, and if it is inside a forward cone and closing, move the NPC's own weapon target to intercept the line (a parry), or step back or sidestep. That fits the official wording "see threats in front" and "know where opponents' weapons are". Because the guard is physical, a guard held in line blocks for free, without any explicit block decision. That would explain the "sword right at your face" observation.

### Gaps
- No source gives reaction times, prediction horizons, or whether NPCs read the player's mouse input or only weapon kinematics.

## Q3: How does it react to losing balance, injuries, being disarmed?

### Takeaway
Physics handles the reactions: balance is a motor-held body, injuries are simulated as broken or dislocated bones, dismemberment and pain. On top of that sit some explicit rules: pain or broken limbs make AI give up, choked AI fights back, there is a give-up/surrender path, taunting can make NPCs submit, and NPCs pick up and steal weapons (tuned down in 0.7.0.2).

### Cited Findings
- 0.6.1.4: "Pain makes AI give up, so breaking limbs will end the fight for them"; "AI will try to fight back when u choke them"; "Made fighting from ground more effective". — [Steam news](https://store.steampowered.com/news/app/2397300)
- Hotfix 3 at EA launch: "You can talk your enemies into submission via the taunt mechanic, NPCs will react". — [Steam news](https://store.steampowered.com/news/app/2397300) (2026-02-03)
- 0.6.1.5: characters fight "to his last breath… Even if you are cut in half, you still dont die instantly". The same patch made bone dislocation harder. — [Steam news](https://store.steampowered.com/news/app/2397300)
- Disarming and weapons:
  - 0.7.0.2: "Grabbing someone's weapon doesn't make them release it" and "NPC's no longer steal weapons from your hands".
  - HotFix 5 (Feb 2026): stolen enemy weapons "sometimes not updating for the weapon's owner".
  - 0.7.0.3: "Stolen weapons unable to be picked up" fixed.
  - Source for all of the above: [Steam news](https://store.steampowered.com/news/app/2397300)
- Navigation and terrain weakness [CONFIRMED known bug]:
  - 0.7 known issues: "Enemies struggle to understand there is a giant pit in front of them".
  - 0.7.0.1: "Fixed NPC navigation, they should stop going straight to their death in the Pit".
  - 0.7.0.3: "Fight completion bug - added secondary check for active opponents - no more progression fights that won't end".
  - Source for all of the above: [Steam news](https://store.steampowered.com/news/app/2397300)
- Demo balance levers: "Falling down is now harder; Getting up is faster". These are global stability tuning, not AI-specific. — [Steam: New Demo Update](https://store.steampowered.com/news/app/2397300) (2025-05-22)
- [PLAYER REPORT] Disabling the legs stops armoured halfswording rushers: "The opponent can't run at you half-swording if you disable his legs". Leg sweeps and trips are recommended counters. — [Steam thread](https://steamcommunity.com/app/2397300/discussions/0/590684692649472658/)
- [PLAYER REPORT] AI arm pathing sometimes tangles its own weapon, and NPCs occasionally die from their own stuck weapon. — search summary of [Steam discussions](https://steamcommunity.com/app/2397300/discussions/0/4038101970213132152/)

### Inferences
- [SPECULATION] The design pattern is "physics gives the reaction, AI reads the body state". The AI checks flags such as limb broken, pain over a threshold, prone, or weapon in hand, and switches behaviour: give up, crawl and fight from the ground, or re-arm or grab. Balance loss is not a separate AI behaviour. It falls out of motor strength versus external impulse.

### Gaps
- No source describes AI-specific get-up logic, or whether NPCs deliberately retrieve dropped weapons. The dev only mentions "knowing where their weapons are", which suggests they can.

## Q4: Difficulty scaling and gauntlet/arena progression

### Takeaway
Difficulty scales mainly through opponent tier/rank (gear, weapons, armour) and enemy count, plus AI competence that is lower "on lower ranks". Progression has gone through several forms: Gauntlet ranks with points in the 2025 demo; Progression ranks from "Beggar" to Baron in EA; the Abyss/Purgatory death mode; and in 0.7, the Crypts, with floors of rising tiers of equipment and enemies and a boss to extract.

### Cited Findings
- 2025-04-02: "Added a new Gauntlet Mode, where you earn points to unlock new Ranks. Dying in that mode sends you to the Abyss. Dying in the Abyss deletes your current character… Free Mode you can play all the Ranks… except the final one, the new Barron tier." — [Steam: End of Playtests & Demo Major Update](https://store.steampowered.com/news/app/2397300)
- In EA Progression mode, players start with their fists as a "Beggar" and rank up by winning, unlocking arenas, armour and weapons. Abyss follows death. Free Mode lets players pick opponents. — [Wikipedia](https://en.wikipedia.org/wiki/Half_Sword)
- 2024 playtest: you pick a tier and are assigned to one of four factions; enemies come from other factions. A "Play Card" option chooses single combat or another fight type. — [Steam: Playtest Update #1](https://store.steampowered.com/news/app/2397300) (2024-08-05)
- 0.7 Crypts: "Each 'floor' contains increasing tiers of equipment and enemies… vanquish a boss and choose to walk up the stairs". Kill count increases the walk to salvation and "affects the numbers of enemies, just like Abyss". Permadeath was removed for now "due to the number of complaints about dying not because of your skill, but because of physics bugs". AI "still make mistakes (especially on lower ranks)". — [Steam 0.7](https://store.steampowered.com/news/app/2397300)
- 0.6.1.1: "Less equipped characters are much less likely to rush a better equipped opponent". This is a gear-aware aggression parameter. — [Steam news](https://store.steampowered.com/news/app/2397300)

### Inferences
- [SPECULATION] Per-rank AI skill is probably a set of parameters: reaction delay, threat-perception accuracy, aggression, and possibly motor strength. "Muscle progression" exists for the player (HotFix 5 mentions "Muscle progression… when spending stamina"), so NPC strength could also scale with rank.

### Gaps
- No published numbers for per-rank AI parameters.

## Q5: Known weaknesses and exploits players report

### Takeaway
The recurring themes are: AI rushes in halfsword stance (especially armoured AI); little reaction to guard changes; it can be beaten by leg attacks, trips and rushing; first strike wins; NPCs walk into pits (fixed in 0.7.0.1); grab and steal oddities; and fights that never end. The AI quality perceived in the demo is often rated higher than in early EA.

### Cited Findings
- [PLAYER REPORT] On July 2026 builds:
  - Armoured enemies "halfsword the weapon… and then just run at me at mach 8".
  - Counters: backpedal and attack the legs; reverse-grip pick and crouch-sweep; a heavy axe polearm; keep range.
  - Another player says the AI "does half sword against armored opponents since the playtest", which suggests an armour-aware weapon-grip choice.
  - Source: [Steam thread](https://steamcommunity.com/app/2397300/discussions/0/590684692649472658/)
- [PLAYER REPORT] On 2023 demo builds: attacks feel "unreactable"; spear enemies are the most dangerous; against the scythe enemy, "just gotta rush him". — [Steam thread](https://steamcommunity.com/app/2397300/discussions/0/4038101970213132152/)
- A speedrun.com forum thread is titled "cool trick i found to survive longer" (content not read). — [speedrun.com](https://www.speedrun.com/sv-SE/HalfSword/forums/2cteu)

### Gaps
- r/HalfSword threads could not be reached through search. YouTube AI analyses were not found.

## Q6: General techniques for AI in physics-driven melee fighters (and comparable games)

### Takeaway
Industry practice (Half Sword, Bonelab, Blade & Sorcery, Exanima) is a hand-authored decision layer (FSM, behaviour tree or utility system) that outputs animation, pose and IK targets. An active ragdoll then tracks those targets with PD/joint motors whose stiffness drops on hits. Research (Won 2021, ASE 2022, DeepMimic lineage) replaces the decision and pose layers with RL policies that output PD target poses. These produce emergent fencing and boxing tactics, but cost CPU-days to GPU-years of training and are not used in shipped melee games.

### Cited Findings
- **Won, Gopinath, Hodgins, "Control Strategies for Physically Simulated Characters Performing Two-player Competitive Sports" (SIGGRAPH 2021, TOG 40(4)) [CONFIRMED, full text read]:**
  - The action space is a target posture: "We control the players in both environments by using a target posture (i.e. a set of target joint angles), then a stable PD controller computes joint torques for all joints except for the root joint."
  - Training has two stages. First, imitation pretraining from motion capture with a multiplicative imitation reward and early termination. Second, transfer to competitive self-play through a task encoder that outputs weights over a mixture-of-experts motor decoder. Fencing used 4 experts, boxing 8; each expert has two layers of 64 units. An autoregressive smoothing of expert weights mattered a lot in ablations (AR 0.9 was best).
  - Fencing setup: a blade welded to the right hand, a 12 m × 2 m arena, foil-like torso touches, and a draw if the opponent counter-touches within 1 s. Reward = r_match (±1 once at the end) + w·r_close − penalties for falling and going out of the arena.
  - Compute: 12 machines × 2 CPUs. About 1 day for imitation pretraining and 2–3 days (2e8–3e8 tuples) for fencing competition; boxing took 4–5 days.
  - Emergent behaviour: "one fencer typically learns aggressive tactics while the other… defensively". Bouts end within about 5 s. Boxers jab at mid range and combo when in reach.
  - Stated limitations: high sample cost (multi-agent setups can need around a billion tuples), motions that look only as natural as the mocap, and grappling/wrestling skills that are not handled.
  - Sources: [Meta AI page](https://ai.meta.com/research/publications/control-strategies-for-physically-simulated-characters-performing-two-player-competitive-sports/); [PDF](https://hbryu.github.io/Control%20Strategies%20for%20Physically%20Simulated%20Characters%20Performing%20Two-player%20Competitive%20Sports.pdf)
- **ASE (Peng, Guo, Halper, Levine, Fidler; SIGGRAPH 2022, NVIDIA):** a reusable latent skill embedding learned from unstructured mocap by adversarial imitation plus unsupervised skill discovery. Training ran on Isaac Gym with about a decade of simulated experience. A sword-and-shield gladiator is the showcase. Downstream tasks such as heading, reach, location and **strike** are trained as high-level policies over the latent space using simple task rewards. — [NVIDIA project page](https://research.nvidia.com/labs/toronto-ai/ASE); [arXiv 2205.01906](https://arxiv.org/abs/2205.01906); [MimicKit ASE README](https://raw.githubusercontent.com/xbpeng/MimicKit/main/docs/README_ASE.md)
- **Follow-up from the same group:** Wang, Hodgins, Won, "Strategy and Skill Learning for Physics-based Table Tennis Animation" (SIGGRAPH 2024). It uses a hierarchical skill controller plus a strategy layer to avoid mode collapse, and was tested with agent-vs-agent and human-vs-agent play in VR. — [arXiv 2407.16210](https://arxiv.org/abs/2407.16210)
- **Blade & Sorcery:**
  - Creature AI is configured in JSON "Brains" holding parameters such as "aim precision, strafe distance, attack speed…", with BehaviorTrees in JSON (marked WIP in docs). — [BasSDK JSON overview](https://kaidevvy.github.io/BasSDK/Modding/SDK/JSON/JSONs-An-Overview.html)
  - Mods tune "attack delays… depending on the difficulty" and counter-attack after a block.
  - "AdaptiveAI" layers behaviour trees for aggression, defence, spacing, timing and prediction.
  - "SharpAI" adds more than 1800 lines of C# to KospY's original AI code.
  - Sources: [Nexus 3207](https://www.nexusmods.com/bladeandsorcery/mods/3207), [Nexus 600](https://www.nexusmods.com/bladeandsorcery/mods/600) (pages not readable directly; descriptions are from search snippets)
- **Bonelab:** An NPC overhaul mod describes the stock system as keeping "BONELAB's locomotion and animation targets" while the mod limits joint stiffness when standing and yields more during hits and falls. This is the classic animation-target active ragdoll. Injuries such as a broken leg impair walking. — [Thunderstore NPC Physics Overhaul](https://thunderstore.io/c/bonelab/p/DrPIE/NPCPHYSICSOVERHAUL/)
- **Unity middleware:** PuppetMaster integrates with Emerald AI so that AI can be knocked down and get back up. There is no evidence Stress Level Zero uses it. — [Emerald AI wiki](https://github.com/Black-Horizon-Studios/Emerald-AI/wiki/PuppetMaster-Integration-Tutorial)
- **Exanima:** The store page claims "complex and smart AI" and "truly physics based combat". No technical description was found. — [Steam](https://store.steampowered.com/app/362490)

### Inferences: practical recipe for a browser physics sword game [SPECULATION/engineering judgment, synthesized from the above]
1. **Body:** Use an active ragdoll (Rapier/Ammo/Cannon/Jolt-wasm). A kinematic "ghost" target skeleton is posed procedurally with two-bone IK for the arms toward a hand/weapon target and procedural foot placement. Physical joints track it with PD or motor drives. Hold the pelvis with a soft constraint to an upright, capsule-like root, the Half Sword trick, and scale motor strength with stamina, pain or injury. That one knob produces staggers, collapse and weakened limbs for free.
2. **Shared input API:** The AI emits the same control intents as the player: a hand/weapon target in an attack plane, grip or stance, step direction, grab. This keeps the AI honest under the same physics, and it is what Half Sword and the Exanima-style "same functions as player" approach appear to do.
3. **Attacks:** Build them as parametric 2–3-waypoint target paths (guard → windup → strike-through point behind the target body part), with timing and noise per difficulty. Add a random windup-hold time so attacks do not read as robotic. Note the opposite complaint, "pre-swing pose then arm snap", which argues for visible, telegraphed windups.
4. **Defence:** Each tick, for each opponent weapon, sample tip and edge positions and velocities, extrapolate about 150–300 ms ahead, and test against the NPC's capsule zones. If a threat is found, choose among (a) an intercept guard (put your blade on the threat's line, perpendicular), (b) a back-step or sidestep, (c) a counter-thrust if the opponent is overcommitted. Reaction delay and prediction error are the difficulty knobs. Keep a default "point in line" guard, since it beats rushers passively.
5. **Decision layer:** A utility AI or small BT over the states approach / hold-distance / attack / defend / recover / flee-surrender. Score using range versus weapon reach, own and opponent stamina, injury flags, the gear comparison (Half Sword 0.6.1.1), and whether the opponent's weapon is in a threatening position.
6. **State reactions:** Read physical flags (grounded/prone, limb broken, disarmed, pain) and switch behaviour. Pain over a threshold means give up (Half Sword 0.6.1.4). Prone means a ground-fighting mode. Disarmed means retrieving the nearest weapon or grappling.
7. **Navigation:** Test hazards (pits, edges) explicitly, since Half Sword shipped with NPCs walking into the pit.
8. **RL is optional and offline:** Won 2021 shows that PD-target RL policies can learn fencing tactics, but at CPU-days per sport. A browser game could at most run a small pre-trained MLP (ONNX/TF.js) over a low-dimensional action space, for example outputting the hand target and stance rather than full joint targets, trained offline against the game's own physics. Hand-authored utility AI is the pragmatic default.

### Gaps
- DeepMimic (Peng et al. 2018), Unity ML-Agents melee examples, EA SEED and Ubisoft La Forge physics-combat work were not reviewed in this pass. No browser-specific physics melee AI case study was found.
- Blade & Sorcery's exact block/parry detection logic was not found. It is likely visible in SharpAI's source.
