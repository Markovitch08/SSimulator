# Half Sword: Physics, Character Control, Weapon and Damage Systems

Scope note: current to 2026-11-20. The richest primary sources are (a) Game Director Frank Togonidze's ("Knives_Frank") 2022–2023 replies on the original itch.io build's comment pages, and (b) the official Steam announcements and patch notes (2024-07 to 2026-11-17). I pulled the full announcement texts from Steam's public news API, `ISteamNews/GetNewsForApp` for appid 2397300. Each item's canonical URL is given as `https://store.steampowered.com/news/app/2397300/view/<gid>`. Labels used below: **[DEV]** = confirmed developer statement, **[3P]** = third-party report, **[SPEC]** = my inference.

Release timeline: itch.io build in 2022, then a Steam "Abyss" demo. The Steam playtest started in July 2024. Playtest and demo were merged in April 2025. Early Access launched on 30 January 2026 [(Steam API appdetails / store)](https://store.steampowered.com/app/2397300/Half_Sword/), followed by 0.6.1 (June 2026) and 0.7 "The Crypts" (10 November 2026). The Steam FAQ calls the game "Unreal Engine 5" [(Steam FAQ thread)](https://steamcommunity.com/app/2397300/discussions/0/4513255283370048156/). Wikipedia lists Unreal Engine 5, the Georgian studio Half Sword Games, publisher Game Seer Publishing, and a team of about 10 [(Wikipedia)](https://en.wikipedia.org/wiki/Half_Sword).

## 1. What engine/physics backend and what technique drives characters (pure physics vs blended animation)?

### Takeaway
Half Sword runs on Unreal Engine 5 (modders report 5.4, so Chaos physics by default). Its characters are a custom active ragdoll the director built himself. A hidden, unsimulated "driver" skeleton runs an Anim Blueprint whose limb poses come entirely from procedural Two-Bone IK, with no keyframed arm or leg animation. The simulated ragdoll follows that skeleton through joint/constraint motors. The ragdoll pelvis is tied to the character collision capsule by a free-limit physics constraint, and linear and angular motors whose strength is retuned continuously hold the body upright. The system was rebuilt "from the ground up" for performance in June 2026.

### Cited Findings
- **[DEV]** On how the body stays balanced: "I connect pelvis of the mesh to the collision capsule by a physics constraint." "I set all the limits to free and use linear and angular motor to keep the body in place and upright." "I constantly change the values of those motors powers so that result looks natural." He also says this makes the capsule and mesh "kind of 'rubber bound' to each other." — [itch.io comments (Knives_Frank, about 2022)](https://knives-frank.itch.io/halfsword/comments?before=21); [also here](https://knives-frank.itch.io/halfsword/comments?before=13)
- **[DEV]** On the driver skeleton: "I have this weird system where I have a hidden skeleton, which is not simulated and plays Anim BP." "All the animations are done procedurally here (so no keyframe animations for arms/legs)." "I am also using exclusively Two Bone IK for every limb." — [itch.io comments](https://knives-frank.itch.io/halfsword/comments?before=21)
- **[DEV]** Practical advice on joint drives: "if you work with joint/constraint motors, I do not recommend using SLERP in this case". He also wrote: "knowing biomechanics would really help to set up correct Physics Asset and IK control system", and "there is not much information about full body animation on Unreal in internet." — [itch.io comments](https://knives-frank.itch.io/halfsword/comments?before=21)
- **[DEV]** On the 0.6.1 rebuild (20 June 2026): "Active Ragdoll Total Overhaul. Massively optimized ragdolls and rebuilt the whole structure from the ground up. Gonna be frank, I made this system years ago and it worked well, but was too performance-heavy. Now it is twice as good performance-wise and hopefully feels the same (or even better)." — [Steam: Update 0.6.1 Patch Notes](https://store.steampowered.com/news/app/2397300/view/1835871199308915)
- **[DEV]** From the March 2026 feedback post: "The player model operates as a unified dynamic physics system. Every new procedural animation such as grips, stances, or damage reactions introduces new variables that must be tested and rebalanced." — [Steam: Addressing Common Feedback (19 Mar 2026)](https://store.steampowered.com/news/app/2397300/view/1827626365753967)
- **[DEV]** On substepping (Hotfix 4, 6 Feb 2026): "Lowered character physics substepping intervals. Expected results: better physics precision. Character control and combat should feel better." The same hotfix "Disabled collision between character and their weapons" to stop weapons getting stuck and to stop long weapons tipping their wielder over. — [Steam: Hotfix 4](https://store.steampowered.com/news/app/2397300/view/1823825466500308)
- **[DEV]** In an Epic Games Store feature, Togonidze says he "ended up stopping on the full physical simulation as the main mechanic", and that "Videos of active ragdoll people cutting each other with swords got traction on Twitter and Reddit." The project was remade several times after 2019–2020 prototypes. — [Epic Games Store feature (via search snippet; the page returned 403 to direct fetch)](https://store.epicgames.com/news/how-half-sword-makes-bloody-brutal-medieval-combat-feel-real); [Wikipedia](https://en.wikipedia.org/wiki/Half_Sword)
- **[DEV]** An early first-person camera was "just a camera attached to physical head". In 0.6.1.5 this became per-helmet FPV camera offsets "so you will see from the slits." — [itch.io](https://knives-frank.itch.io/halfsword/comments?before=13); [Steam: Patch 0.6.1.5](https://store.steampowered.com/news/app/2397300/view/1837955055363781)
- **[3P]** Nexus mod 503 says "the game runs on UE 5.4" and recommends an experimental UE4SS build for that reason. The install path is `HalfSwordUE5\Binaries\Win64` and the executable is `HalfSwordUE5-Win64-Shipping.exe`. — [Nexus mod 503 (search snippet)](https://www.nexusmods.com/halfsword/mods/503); [massclown HalfSwordTrainerMod README](https://github.com/massclown/HalfSwordTrainerMod)
- **[DEV]** On early performance: the itch build "runs fine on my school PC, but on my personal laptop starts to smoke even on the lowest settings". UE5 also "has problems with Win7". — [itch.io](https://knives-frank.itch.io/halfsword/comments?before=21)

### Inferences
- **[SPEC]** I found no source that says whether the game uses PhysX or Chaos. UE5 removed PhysX as the default, and 5.4 ships only Chaos, so the game is almost certainly on Chaos. The talk of "substepping intervals" fits Chaos async/substep settings.
- **[SPEC]** The developer describes constraint motors on a Physics Asset, driven toward a hidden animated skeleton. That is functionally the same as UE's Physical Animation Component, or per-constraint angular drives with SetAngularOrientationTarget, which are PD springs with stiffness and damping. Nothing confirms whether he used the Physical Animation Component, the newer Physics Control component, or raw constraint drives. "I made this system years ago" (2022) predates the experimental Physics Control plugin, which points to custom constraint-motor code. His warning against SLERP drive suggests Twist/Swing angular drive mode.
- **[SPEC]** The capsule-to-pelvis constraint is a hybrid "puppet on a kinematic/character controller" design. The CharacterMovement capsule handles locomotion and ground contact, and the ragdoll hangs from it through a soft 6-DOF spring. Balance therefore comes mostly from that root spring, not from a center-of-mass controller.

### Gaps
- No published drive stiffness or damping values, motor gains, or physics-asset layout. The Epic feature could not be fetched in full (403).
- No source confirms Chaos vs PhysX, the Physics Control plugin, or the substep rate in Hz.
- No developer description of the 0.6.1 rebuild's new structure beyond "twice as good performance-wise."

## 2. How does mouse input become sword motion? What makes hits feel weighty?

### Takeaway
Mouse movement directly moves the hand/weapon IK target. The developer calls this "really the core of this whole game." Mouse buttons and modifier keys switch between control modes: swing, thrust/alt-thrust, half-sword grip, reverse/mordhau grip, upper-body control and "attack chain." The weapon is a physically simulated body with "real weight and point of balance." Weight comes from real mass and centre of balance acting against the character's finite muscle (motor) strength, which scales with a persistent strength/muscle stat. Weapon weight is also a user setting.

### Cited Findings
- **[DEV]** "Yes, mouse movement is really the core of this whole game. Dismemberment and everything else comes later." — [itch.io comments](https://knives-frank.itch.io/halfsword/comments?before=21)
- **[DEV]** On weapon mass: "all the weapons have real weight and point of balance." Asked to make weapon weights differ, he replied "I need to change muscle power of the character and fine tune physics better, probably." — [itch.io](https://knives-frank.itch.io/halfsword/comments?before=13)
- **[DEV]** Playtest Update #1 (5 Aug 2024) changed the physics system "impacting all aspects of gameplay … should make wielding weapons feel better, especially long and heavy ones." Thanks to that update, some weapons went back "to their historically accurate weight and size." Two-handed weapons gained hand switching on "X". — [Steam: Playtest Update #1](https://store.steampowered.com/news/app/2397300/view/5963413728349374051); [PCGamesN](https://www.pcgamesn.com/half-sword/physics-update)
- **[DEV]** The Blood update (Nov 2024) added kicking (Space), more parry control, and "Improved grip switching! Now you will not do One Punch Man punch every time you grab your weapon." — [Steam: Blood update is here!](https://store.steampowered.com/news/app/2397300/view/1783872412026800)
- **[DEV]** 0.6.1 (June 2026) control additions:
  - "Reverse gripping … rotate your weapons (vertically for bladed weapons and horizontally for the rest) by holding down the Swap Hands key. With swords, you can go to the mordhau grip if you do that from the halfsword grip … without proper hand protection you may cut yourself."
  - A reworked alt-thrust allows the *zwerchau*, inspired by the community mod "The Art of Combat."
  - "Stronger wrists. Made wrists more rigid so that your weapons flop less. Basically returned wrist mobility to Demo settings."
  - "Equipment affects mobility … The heavier you are, the heavier the movement feels. Increasing physical strength makes you move more lightly in armor."
  - Source: [Steam: Update 0.6.1](https://store.steampowered.com/news/app/2397300/view/1835871199308915)
- **[DEV]** In 0.6.1.1 and 0.6.1.2, tapping Alt Thrust toggles Classic Thrust, and holding it gives "Thumb Grip". "From Classic Thrust releasing mouse button momentarily will bring you back to Swing Mode." Pommels and guards were made "more effective for striking to make Mordhau grip even deadlier." — [Steam: 0.6.1.1](https://store.steampowered.com/news/app/2397300/view/1835871199310386); [Steam: 0.6.1.2](https://store.steampowered.com/news/app/2397300/view/1835871199311729)
- **[DEV]** On half-swording input: "Added option for Classic Halfswording controls in options (when u just press RMB) … with new controls, you need to hold down both RMB and LMB." — [Steam: Hotfix 1 for 0.6.1.4](https://store.steampowered.com/news/app/2397300/view/1836506165562235)
- **[DEV]** 0.7 (10 Nov 2026):
  - "Switching grips is one of the most complicated things you can do with physics based characters and weapons and Half Sword goes hard with grips … switching grips is more reliable now."
  - "If you hold Alt without holding down mouse buttons you will be able to control your whole upper body with a mouse."
  - On MB3 "attack chain" mode: "a neutral gear for your arms - you control your weapon with your mouse but you character holds it behind," which allows repeated same-side cuts.
  - "Weapons should feel heavier now, but you can adjust that in the settings. Characters should feel 'meatier'." A "Weapon Weight" slider was added.
  - Source: [Steam: 0.7 The Crypts Update](https://store.steampowered.com/news/app/2397300/view/1848664643360622)
- **[DEV]** Hotfix 0.7.0.1 made weapons "lighter by default" and cut the Weapon Weight setting's effect by 50%. — [Steam: Hotfix 1 for 0.7](https://store.steampowered.com/news/app/2397300/view/1849192144182511)
- **[DEV]** Muscle and strength is a persistent stat. "Muscle progression wasn't always triggering when spending stamina" (Hotfix 5). Later, "Muscle progression get slower the more you progress. It is still uncapped" (0.7.0.3). Eating bread adds mass (0.7). — [Steam: Hotfix 5](https://store.steampowered.com/news/app/2397300/view/1823825466503413); [Steam: Hotfix 3 for 0.7](https://store.steampowered.com/news/app/2397300/view/1849458702695002)
- **[DEV]** Height and weight sliders "are multipliers, so a Knight with full Weight will still have more muscles than a Beggar." — [Steam: 0.6.1.2](https://store.steampowered.com/news/app/2397300/view/1835871199311729)
- **[DEV]** The store page says you "wield your weapon with precision using your mouse", in a system "based on the expertise and feedback of Historical European Martial Arts (HEMA) practitioners." — [Steam store](https://store.steampowered.com/app/2397300/Half_Sword/)
- **[3P]** Wikipedia describes the controls as freeform "ragdoll" controls driven mainly by directional mouse movement. — [Wikipedia](https://en.wikipedia.org/wiki/Half_Sword)

### Inferences
- **[SPEC]** Mouse delta most likely moves a 2D/3D hand target in a body-relative frame. The hidden skeleton's Two-Bone IK solves the arm toward that target, and the ragdoll's motors chase the IK pose with finite strength. Weight then emerges for free. A heavy or far-from-hand centre of mass lags the target, overshoots, and carries momentum. The "Weapon Weight" slider probably scales weapon mass, or the motor-strength ratio. Grip modes appear to be different hand attachment points or constraint frames on the weapon, plus different IK target mappings. Swapping them mid-simulation causes the instability the developers describe.
- **[SPEC]** The wrist-stiffness change shows that wrist drive stiffness is a key tuning knob. Lower stiffness gives more "floppy" edge misalignment, higher stiffness gives more control.

### Gaps
- No exact mouse-to-target mapping (sensitivity curves, plane of motion, depth control) was found in developer text.
- No published mass values per weapon.

## 3. How is damage computed (velocity, edge vs flat, hit location, armor layers)?

### Takeaway
The developers have not published formulas. Confirmed elements:
- Each weapon and armor piece has unique collision geometry that "represents its form and ability to do damage."
- Weapons have a "sharpness" property that enables cutting, and contact with non-cuttable surfaces can disable it (a bug fixed in 0.7.0.3).
- Damage depends on hit location: vital organs take more, and there is a "liver hit."
- Since 0.7, plate armor has rigid physics colliders on the body. Weapons physically collide with plate first, and traces then resolve hits on everything else. Before 0.7, all armor hits were trace-based.
- Armor protection depends on metal type, and the "math for armor protection" was refined.
- Blunt damage has been rebalanced repeatedly against armor.

### Cited Findings
- **[DEV]** "Each peace of armor and weapon have unique collisions that represents its form and ability to do damage." — [Steam FAQ](https://steamcommunity.com/app/2397300/discussions/0/4513255283370048156/)
- **[DEV]** 0.7 armor collision change: "plate armor now has its own physics colliders attached to characters's body. Before all the collisions were processed through traces that determined if hit landed on armor or not, now weapons will physically collide with plate armor and only then the trace will check the rest … you will be able to touch and hook armor parts in combat … those colliders are not 1:1 representation of the visual part of armor, because visible armor should bend at least a little bit, while colliders are rigid." — [Steam: 0.7](https://store.steampowered.com/news/app/2397300/view/1848664643360622)
- **[DEV]** In about 2023 the developer promised an "Exanima style" armor collisions system for the next update. — [itch.io](https://knives-frank.itch.io/halfsword/comments?before=13)
- **[DEV]** Sharpness: "Fixed weapon sharpness" (0.7.0.1), and "Sharpness bug - blade making contact with non-cuttable surfaces disables sharpness no longer cutting NPC's" (0.7.0.3). — [Steam: Hotfix 1 for 0.7](https://store.steampowered.com/news/app/2397300/view/1849192144182511); [Steam: Hotfix 3 for 0.7](https://store.steampowered.com/news/app/2397300/view/1849458702695002)
- **[DEV]** 0.7: "Cutting through flesh feels more like cutting through flesh, punching feels more like punching". 0.6.1.5: "Draw cutting should be much better and effective" and "Weapons now get stuck in wooden surfaces." — [Steam: 0.7](https://store.steampowered.com/news/app/2397300/view/1848664643360622); [Steam: 0.6.1.5](https://store.steampowered.com/news/app/2397300/view/1837955055363781)
- **[DEV]** Hit-location weighting: "Rebalanced damage, more damage to vital organs, less to non vital" (May 2025 demo), and "Liver hit added" (EA Hotfix 2). — [Steam: New Demo Update](https://store.steampowered.com/news/app/2397300/view/1800357164401182); [Steam: Hotfix 2](https://store.steampowered.com/news/app/2397300/view/1823191198607822)
- **[DEV]** Armor material and metal: "Better metal gives more protection and restricts your movements less." "Armor protection rebalance. Refined the math for armor protection. It should be harder to one-shot a fully armored knight now." — [Steam: 0.6.1](https://store.steampowered.com/news/app/2397300/view/1835871199308915)
- **[DEV]** Blunt vs armor history:
  - Nov 2024: "Nerfed blunt damage and boosted armor defense against it." [Steam: Blood update](https://store.steampowered.com/news/app/2397300/view/1783872412026800)
  - May 2025: "nerfed warstaff's damage against armor." [Steam: New Demo Update](https://store.steampowered.com/news/app/2397300/view/1800357164401182)
  - July 2026: "Nerfed base blunt damage, Nerfed naked fists damage, Nerfed Pollaxe shaft damage." [Steam: 0.6.1.5](https://store.steampowered.com/news/app/2397300/view/1837955055363781)
  - Nov 2026: "Padded armor slightly debuffed." [Steam: Hotfix 2 for 0.7](https://store.steampowered.com/news/app/2397300/view/1849192144186840)
- **[DEV]** Impact damage from bodies and objects: "Made body slamming make more damage. Using other Willie's as weapons, using their severed arms and legs … ramming them" (0.6.1.3). This was later reduced: "Less damage on body slamming (for less random headbutting)" and "Fixed explosive damage when you grab someones arm while they are holding shields … Less random explosive damage in general" (0.6.1.4.1). — [Steam: 0.6.1.3](https://store.steampowered.com/news/app/2397300/view/1836506165554465); [Steam: Hotfix 1 for 0.6.1.4](https://store.steampowered.com/news/app/2397300/view/1836506165562235)
- **[DEV]** Crossbow bolts got better collision detection, and the crossbow is "well balanced against armor". — [Steam: Hotfix 1 for 0.6.1.4](https://store.steampowered.com/news/app/2397300/view/1836506165562235); [Steam: 0.6.1.5](https://store.steampowered.com/news/app/2397300/view/1837955055363781)
- **[DEV]** Settings: the minimum on the damage slider went from 10% to 1%. — [Steam: 0.6.1.5](https://store.steampowered.com/news/app/2397300/view/1837955055363781)
- **[3P]** A fan site (not official) says blunt damage against armored opponents was increased in EA. This conflicts with the official nerf history above, so treat it as unverified. — [half-sword.pages.dev](https://half-sword.pages.dev/blog/new-mechanics-early-access)

### Inferences
- **[SPEC]** "Explosive damage" bugs from grabbing, and from body-slam or headbutt impacts, strongly suggest damage is computed from physics impact data: relative velocity and impulse at contact, scaled by the collider's damage profile. Constraint fights between grabbed bodies produce spurious huge impulses. Cutting appears gated by a per-weapon edge/sharpness flag plus contact geometry. The "sharpness disabled by non-cuttable contact" bug implies a per-swing state machine. The developers confirm a hybrid physics-collider-plus-trace model for armor. Penetration likely depends on weapon class, impact energy and armor metal tier.

### Gaps
- No developer formula for velocity or energy thresholds, edge-alignment checks, or armor penetration. I found no datamined damage curves.

## 4. Damage/gore model: cutting, blunt trauma, bleeding, limb damage, stamina/consciousness

### Takeaway
The game simulates:
- dynamic mesh slicing ("split em wide open wherever you slice"), plus dismemberment and internal organs
- bruises and blood pooling, and damage to armor and clothing
- joint dislocation and bone snapping, from both impact and twisting or pulling
- strangulation leading to unconsciousness and then death
- pain-driven AI surrender
- stamina-linked muscle growth
- a persistent body state (wounds that heal over time; metabolism, energy and temperature)

The blood system moved from a third-party UE plugin to an in-house "RT Blood" system.

### Cited Findings
- **[DEV]** Blood update (Nov 2024): new blood particles, blood running from wounds, blood pooling, "Armor and clothing damage! Bruises! Internal organs! … DYNAMIC SLICING!!! … split em wide open wherever you slice! And As many times as you want!" It was marked very WIP, with "duplicated bodies, slices not appearing." — [Steam: Blood update is here!](https://store.steampowered.com/news/app/2397300/view/1783872412026800)
- **[DEV]** Crashes "stem from a third-party Unreal Engine plugin we've been using for some of the blood and gore effects … we're now developing our own in-house solution." — [Steam: New Demo Update (May 2025)](https://store.steampowered.com/news/app/2397300/view/1800357164401182)
- **[DEV]** Hotfix 6 (Feb 2026) introduced a "partial implementation of in-house next gen blood system (RT Blood)". It includes new wall and floor decals and weapon-trail blood. "Some fluid blood particle were removed for now for performance." Blood settings cover force, particle count and decal amount. An earlier hotfix "Lowered gravity effect on blood particles." — [Steam: Hotfix 6](https://store.steampowered.com/news/app/2397300/view/1825093633183147); [Steam: Hotfix 4](https://store.steampowered.com/news/app/2397300/view/1823825466500308)
- **[DEV]** On bones: "Joint dislocation, snapping bones by pulling and twisting, snapping neck, back, arms, legs" (0.6.1.3). There is a Bone Fragility slider that "affects both bone dislocation and breaking bones by impact. Turning it down completely will turn off bone snapping, while 'bone breaking' will be just twice harder" (0.6.1.4.1). Also: "Bone dislocation in armor is a little harder, bone dislocation while standing is a little harder" (0.6.1.5). — [Steam: 0.6.1.3](https://store.steampowered.com/news/app/2397300/view/1836506165554465); [Steam: Hotfix 1 for 0.6.1.4](https://store.steampowered.com/news/app/2397300/view/1836506165562235); [Steam: 0.6.1.5](https://store.steampowered.com/news/app/2397300/view/1837955055363781)
- **[DEV]** Bugs with the constraint-based bone system: "Breaking limbs on picking up objects fixed", "Breaking limbs by just grabbing should happen less", and "Unknown force pulling a body on torso dismemberment partially fixed". — [Steam: 0.6.1.3 Hotfix 1](https://store.steampowered.com/news/app/2397300/view/1836506165555048)
- **[DEV]** On consciousness: "You can strangle people to death now. First they lose consciousness and if you keep choking them they die, It takes time." — [Steam: 0.6.1.1](https://store.steampowered.com/news/app/2397300/view/1835871199310386)
- **[DEV]** On pain: "Pain makes AI give up, so breaking limbs will end the fight for them." — [Steam: 0.6.1.4](https://store.steampowered.com/news/app/2397300/view/1836506165560470)
- **[DEV]** On death: "Reworked how death works for player. Now you can control your character to his last breath … Even if you are cut in half, you still dont die instantly." — [Steam: 0.6.1.5](https://store.steampowered.com/news/app/2397300/view/1837955055363781)
- **[DEV]** Persistent body state in 0.7: wounds stay and heal slowly, and "All the injuries are reversible in-game, even broken and dismembered limbs. Metabolism, Energy and Temperature systems are fully functioning." Hotfix 2 fixed a stamina and weapon-weight bug caused by save incompatibility. — [Steam: 0.7](https://store.steampowered.com/news/app/2397300/view/1848664643360622); [Steam: Hotfix 2 for 0.7](https://store.steampowered.com/news/app/2397300/view/1849192144186840)
- **[3P]** The trainer mod's HUD shows "the health of the body parts" as a body figure. Its README warns that "some injuries will drain the health / tonus / other stats and kill the player again." It also observes that "the game itself … makes your player invulnerable for a first few seconds during spawn (maybe to avoid dying due to physics of the game?)." — [massclown HalfSwordTrainerMod README](https://github.com/massclown/HalfSwordTrainerMod)

### Inferences
- **[SPEC]** The modder's term "tonus" (muscle tone) suggests a global stat that scales ragdoll motor strength. As tonus drains through injury, blood loss or exhaustion, the body goes limp. That would explain how consciousness and death show up physically, which is a common active-ragdoll pattern. This was observed in the demo era and is unconfirmed by the developers.
- **[SPEC]** Bone dislocation and snapping are probably implemented as constraint-break thresholds on twist, swing and linear stress. That fits "pulling and twisting" and the false breaks during grabs.

### Gaps
- No developer documentation of the bleed rate or blood-volume model, or of the stamina formula. The trainer mod's Lua source was not retrieved, because the raw path returned 404 and the GitHub API was blocked in this session, so its exact UObject variable names are unconfirmed.

## 5. How is balance/falling/getting knocked down handled?

### Takeaway
Balance is a soft constraint: capsule-to-pelvis linear and angular motors with continuously retuned strength. Stepping is procedural foot placement with ground traces and Two-Bone IK. Knockdown happens when external forces overwhelm the motors. The developers have repeatedly tuned how easy it is to fall and get up, and EA reviewers specifically complained that characters ragdoll too easily.

### Cited Findings
- **[DEV]** On balance: the pelvis is constrained to the collision capsule, with linear and angular motors keeping "the body in place and upright". On walking: "before every step I trace the land at the location where I want foot to step on." — [itch.io](https://knives-frank.itch.io/halfsword/comments?before=21)
- **[DEV]** May 2025 demo: "Falling down is now harder. Getting up is faster." — [Steam: New Demo Update](https://store.steampowered.com/news/app/2397300/view/1800357164401182)
- **[DEV]** Feb 2026: "longer weapons shouldn't cause wielder to fall over when stuck", after self-collision between a character and its own weapon was disabled. Kicking from the ground was added. — [Steam: Hotfix 4](https://store.steampowered.com/news/app/2397300/view/1823825466500308)
- **[DEV]** 0.6.1.4 "Made fighting from ground more effective". 0.6.1.5 made "Fallen bodies … heavier, dead weight should feel more like dead weight" and added a slider for fallen body weight scale. 0.6.1.3 Hotfix 1 fixed "Excessive hips rotation on low framerate". 0.7 added crouch (tap Ctrl), prone (hold Ctrl) and improved jumping. — [Steam: 0.6.1.4](https://store.steampowered.com/news/app/2397300/view/1836506165560470); [Steam: 0.6.1.5](https://store.steampowered.com/news/app/2397300/view/1837955055363781); [Steam: 0.6.1.3 Hotfix 1](https://store.steampowered.com/news/app/2397300/view/1836506165555048); [Steam: 0.7](https://store.steampowered.com/news/app/2397300/view/1848664643360622)
- **[DEV]** 0.6.1: "Made characters faster and more nimble in general, but heavy equipment … will affect that." — [Steam: 0.6.1](https://store.steampowered.com/news/app/2397300/view/1835871199308915)
- **[3P]** PC Gamer (March 2026) reports that EA reviews complained combat was harder to control and sent characters into ragdoll more easily than the demo, and that the team ruled out reverting to the demo model. — [PC Gamer, Rick Lane, 2026-03-22 (search summary; body not fetchable)](https://www.pcgamer.com/games/action/with-steam-reviews-at-mixed-the-developer-of-half-sword-addresses-differences-between-the-early-access-game-and-its-hugely-popular-tech-demo-the-final-version-of-the-game-will-differ-from-what-has-been-shown-previously/); [Wikipedia (cites "criticism of the ragdoll system")](https://en.wikipedia.org/wiki/Half_Sword)

### Inferences
- **[SPEC]** "Excessive hips rotation on low framerate" suggests some motor or target updates were framerate-dependent, running on game tick rather than physics substep. That is a classic issue when PD drives are fed per-frame targets. The fallen-body weight slider suggests that a downed or dead character's mass, or its drive strength, is scaled separately from the living state.

### Gaps
- There is no developer explanation of the knockdown threshold logic, for example whether it uses a stability metric, motor saturation, or a state machine that switches drives off.

## 6. Known performance limits, bugs, and design tradeoffs the devs mentioned

### Takeaway
The main problems the developers have acknowledged:
- Active-ragdoll CPU cost (fixed by a 2x rebuild in 0.6.1).
- Blood and gore performance, and crashes from a third-party plugin.
- Foliage-heavy outdoor maps.
- Physics instability from grip switching, grabbing and constraint fights.
- Weapons getting stuck.
- Split-screen crashes (hair).

Design tradeoffs they have stated:
- No online multiplayer; split-screen only.
- Permadeath removed until physics bugs stop causing unfair deaths.
- Performance optimisation deferred mostly to late development.
- Rigid armor colliders approximate the visual armor.

### Cited Findings
- **[DEV]** "Gonna be frank, I made this system years ago and it worked well, but was too performance-heavy." — [Steam: 0.6.1](https://store.steampowered.com/news/app/2397300/view/1835871199308915)
- **[DEV]** "Permadeath is for the moment removed from the game. It was a decision due to the number of complaints about dying not because of your skill, but because of physics bugs." — [Steam: 0.7](https://store.steampowered.com/news/app/2397300/view/1848664643360622)
- **[DEV]** "Half Sword will always be Half Sword and medieval space program is always open for new astronauts." Also: "performance will be our main focus in the very end of development". — [Steam: 0.7](https://store.steampowered.com/news/app/2397300/view/1848664643360622)
- **[DEV]** "Tweaked bone snapping, should be much more stable. Not completely stable, naturally, its Half Sword after all." — [Steam: Hotfix 1 for 0.6.1.4](https://store.steampowered.com/news/app/2397300/view/1836506165562235)
- **[DEV]** "Combat can feel different between updates while these systems continue to evolve … the final version of the game will differ from what has been shown previously." — [Steam: Addressing Common Feedback](https://store.steampowered.com/news/app/2397300/view/1827626365753967)
- **[DEV]** EA-launch issues: Slums map performance; the advice to use DX12; a request to update drivers; and "2h handed weapons might have wrong handling if you swap hands". — [Steam: Half Sword Is OUT NOW](https://store.steampowered.com/news/app/2397300/view/1823191198605899); [Steam: Hotfix 1](https://store.steampowered.com/news/app/2397300/view/1823191198606516)
- **[DEV]** Split screen: hair and volumetric clouds disabled because they caused crashes and glitches. There is also an option to disable hair everywhere. — [Steam: 0.6.1.5](https://store.steampowered.com/news/app/2397300/view/1837955055363781)
- **[DEV]** Multiplayer: "No. We have settled for a Split Screen feature for both Co-op and 1v1 scenarios." — [Steam FAQ](https://steamcommunity.com/app/2397300/discussions/0/4513255283370048156/)
- **[DEV]** System requirements: minimum is an i7-6700HQ or Ryzen 5 3500U with a GTX 1060 6GB; recommended is an i7-12700 or Ryzen 7 7700X with an RTX 4070 or RX 7800 XT. — [Steam store](https://store.steampowered.com/app/2397300/Half_Sword/)
- **[DEV]** A 2024 playtest build had no gore ("family-friendly edition" for Tokyo Game Show), to test "new controls, armor, and weapons" and "weight mechanics". — [Steam: Join the first Half Sword Playtests!](https://store.steampowered.com/news/app/2397300/view/6000566704283336428)
- **[3P]** Mods are built with UE4SS (Lua plus Blueprint LogicMods in `Content\Paks`). Notable examples are the massclown Trainer and Split-Screen mods, and "The Art of Combat," which the developers credit as inspiring the zwerchau stance. The developers advise disabling mods after major updates. — [HalfSwordTrainerMod](https://github.com/massclown/HalfSwordTrainerMod); [HalfSwordSplitScreenMod](https://github.com/massclown/HalfSwordSplitScreenMod); [Steam: 0.6.1](https://store.steampowered.com/news/app/2397300/view/1835871199308915)
- **[3P]** A UE forum post gives a community recipe for a "Half Sword style" active ragdoll: a Physical Animation Component, angular drives, a Control Rig pose snapshot, and orientation strength of about 1500–2000. It is not from the developers or reverse-engineered from the game. — [UE Forums](https://forums.unrealengine.com/t/how-i-spent-weeks-fighting-ue5-physics-to-create-a-gta-4-rdr2-style-active-ragdoll-and-the-exact-blueprint-to-do-it/2851065)

### Inferences
- **[SPEC]** Each character is a full multi-body ragdoll with substepping. On top of that come grabs, which add extra constraints, and rigid armor colliders, which add bodies per character since 0.7. So physics cost scales with the number of fighters. That fits the cap of 10 opponents in Free Mode (0.6.1) and the repeated optimisation passes.

### Gaps
- No Kickstarter page content was retrieved, and the campaign's outcome is unconfirmed. Search shows a planned "half-sword-gauntlet" campaign. The devlog and Q&A videos (the Oct 2024 Dev Q&A, and Frank's 0.7 walkthrough video) were not transcribed. Neither the Epic feature (403) nor the PC Gamer body text could be fetched directly. No Discord or Reddit AMA content was found.
