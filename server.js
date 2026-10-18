const express = require('express');
const cors = require('cors');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const pl = require('tau-prolog');
const { encodeCommand, resolveIntentWithProlog } = require('./ml_tokenizer');

const app = express();
app.use(cors());
app.use(express.json());

const DEFAULT_USER = "red_player_1";
const USER_ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const MAX_COMMAND_LENGTH = 200;

const safeJsonParse = (raw, fallback = []) => {
    if (raw === null || raw === undefined || raw === "") return fallback;
    try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : fallback;
    } catch {
        return fallback;
    }
};

// ============================================================================
// DATABASE LAYER
// ============================================================================
const db = new sqlite3.Database(path.join(__dirname, 'game_data.db'));

const runSQL = (sql, params = []) =>
    new Promise((resolve, reject) => db.run(sql, params, (err) => (err ? reject(err) : resolve())));

const ensureColumn = (table, columnName, columnDef) =>
    new Promise((resolve, reject) => {
        db.all(`PRAGMA table_info(${table})`, (err, columns) => {
            if (err) return reject(err);
            if (columns.some(column => column.name === columnName)) return resolve();
            db.run(`ALTER TABLE ${table} ADD COLUMN ${columnName} ${columnDef}`, (alterErr) => {
                if (alterErr) return reject(alterErr);
                resolve();
            });
        });
    });

const dbReady = new Promise((resolve, reject) => {
    db.serialize(() => {
        db.run(`
            CREATE TABLE IF NOT EXISTS player_sessions_v3 (
                user_id TEXT PRIMARY KEY,
                location TEXT,
                stayed_on_path INTEGER,
                talked_to_wolf INTEGER,
                revealed_destination INTEGER,
                forest_delay INTEGER,
                hummed_tune INTEGER,
                warned_woodcutter INTEGER,
                commotion_level INTEGER,
                clues_noticed INTEGER,
                clues_seen TEXT,
                wolf_subdued INTEGER,
                grandmother_untied INTEGER,
                grandmother_wellness INTEGER,
                inventory TEXT,
                chaos_outcome TEXT,
                faction_affinity TEXT DEFAULT 'neutral',
                loop_count INTEGER DEFAULT 0,
                memory_fragments TEXT DEFAULT '[]',
                spectacles_taken INTEGER DEFAULT 0,
                grandmother_mystic INTEGER DEFAULT 0,
                standoff_choice TEXT DEFAULT NULL,
                pact_revealed INTEGER DEFAULT 0
            )
        `, async (err) => {
            if (err) return reject(err);
            try {
                await ensureColumn('player_sessions_v3', 'faction_affinity', "TEXT DEFAULT 'neutral'");
                await ensureColumn('player_sessions_v3', 'loop_count', 'INTEGER DEFAULT 0');
                await ensureColumn('player_sessions_v3', 'memory_fragments', "TEXT DEFAULT '[]'");
                await ensureColumn('player_sessions_v3', 'spectacles_taken', 'INTEGER DEFAULT 0');
                await ensureColumn('player_sessions_v3', 'grandmother_mystic', 'INTEGER DEFAULT 0');
                await ensureColumn('player_sessions_v3', 'standoff_choice', 'TEXT DEFAULT NULL');
                await ensureColumn('player_sessions_v3', 'pact_revealed', 'INTEGER DEFAULT 0');
                db.run(`
                    CREATE TABLE IF NOT EXISTS chaos_logs (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        user_id TEXT,
                        command TEXT,
                        resulting_outcome TEXT,
                        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
                    )
                `, (tableErr) => (tableErr ? reject(tableErr) : resolve()));
            } catch (migrationErr) {
                reject(migrationErr);
            }
        });
    });
});

const getPlayerStateFromDB = (userId) =>
    new Promise((resolve, reject) => {
        db.get(`SELECT * FROM player_sessions_v3 WHERE user_id = ?`, [userId], (err, row) => {
            if (err) return reject(err);
            if (!row) return resolve(null);
            resolve(Object.freeze({
                location: row.location,
                stayedOnPath: Boolean(row.stayed_on_path),
                talkedToWolf: Boolean(row.talked_to_wolf),
                revealedDestination: Boolean(row.revealed_destination),
                forestDelay: row.forest_delay,
                hummedTune: Boolean(row.hummed_tune),
                warnedWoodcutter: Boolean(row.warned_woodcutter),
                commotionLevel: row.commotion_level,
                cluesNoticed: row.clues_noticed,
                cluesSeen: Object.freeze(safeJsonParse(row.clues_seen, [])),
                wolfSubdued: Boolean(row.wolf_subdued),
                grandmotherUntied: Boolean(row.grandmother_untied),
                grandmotherWellness: row.grandmother_wellness,
                inventory: Object.freeze(safeJsonParse(row.inventory, basketItems.map(item => item.name))),
                chaosOutcome: row.chaos_outcome,
                factionAffinity: row.faction_affinity || "neutral",
                loopCount: Number(row.loop_count || 0),
                memoryFragments: Object.freeze(safeJsonParse(row.memory_fragments, [])),
                spectaclesTaken: Boolean(row.spectacles_taken),
                grandmotherMystic: Boolean(row.grandmother_mystic),
                standoffChoice: row.standoff_choice || null,
                pactRevealed: Boolean(row.pact_revealed)
            }));
        });
    });

const savePlayerStateToDB = (userId, s, outcome) =>
    runSQL(`
        INSERT OR REPLACE INTO player_sessions_v3 (
            user_id, location, stayed_on_path, talked_to_wolf, revealed_destination,
            forest_delay, hummed_tune, warned_woodcutter, commotion_level, clues_noticed,
            clues_seen, wolf_subdued, grandmother_untied, grandmother_wellness,
            inventory, chaos_outcome, faction_affinity, loop_count, memory_fragments,
            spectacles_taken, grandmother_mystic, standoff_choice, pact_revealed
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
        userId, s.location,
        s.stayedOnPath ? 1 : 0, s.talkedToWolf ? 1 : 0, s.revealedDestination ? 1 : 0,
        s.forestDelay, s.hummedTune ? 1 : 0, s.warnedWoodcutter ? 1 : 0,
        s.commotionLevel, s.cluesNoticed, JSON.stringify(s.cluesSeen),
        s.wolfSubdued ? 1 : 0, s.grandmotherUntied ? 1 : 0, s.grandmotherWellness,
        JSON.stringify(s.inventory), outcome, s.factionAffinity || "neutral",
        s.loopCount || 0, JSON.stringify(s.memoryFragments), s.spectaclesTaken ? 1 : 0,
        s.grandmotherMystic ? 1 : 0, s.standoffChoice || null, s.pactRevealed ? 1 : 0
    ]);

// Serialize requests per player so read-modify-write cycles never interleave
// (double-submits previously lost updates).
const userLocks = new Map();
const withUserLock = (userId, fn) => {
    const prev = userLocks.get(userId) || Promise.resolve();
    const run = prev.then(fn);
    const tail = run.catch(() => {});
    userLocks.set(userId, tail);
    tail.then(() => { if (userLocks.get(userId) === tail) userLocks.delete(userId); });
    return run;
};

// ============================================================================
// 1. OBJECT-ORIENTED PARADIGM
// ============================================================================
class GameEntity {
    constructor(name, description) {
        this.name = name;
        this.description = description;
    }
    examine() {
        return this.description;
    }
}

class HealingItem extends GameEntity {
    constructor(name, description, wellnessPoints) {
        super(name, description);
        this.wellnessPoints = wellnessPoints;
    }
}

class ForestDetail extends GameEntity {
    constructor(name, description, causesDelay = false) {
        super(name, description);
        this.causesDelay = causesDelay;
    }
}

class NPC extends GameEntity {
    constructor(name, description, dialogue) {
        super(name, description);
        this.dialogue = dialogue;
    }
    speak() {
        return this.dialogue;
    }
}

class Location extends GameEntity {
    constructor(id, name, description, smells, sounds, peacefulDescription = null) {
        super(name, description);
        this.id = id;
        this.smells = smells;
        this.sounds = sounds;
        this.peacefulDescription = peacefulDescription;
    }
}

const basketItems = [
    new HealingItem("bread", "Freshly baked bread prepared by your caring mother.", 15),
    new HealingItem("wine", "A bottle of sweet wine intended to lift Grandmother's spirits.", 10),
    new HealingItem("cakes", "An assortment of comforting sweet cakes.", 10),
    new HealingItem("remedies", "Herbal remedies for Grandmother, who is resting in bed with a cold.", 30)
];

const forestEntities = {
    cloak: new GameEntity("cloak", "Your vibrant, hooded red cloak—a cherished gift from your adoring grandmother."),
    squirrels: new ForestDetail("squirrels", "Squirrels scurrying rapidly up the dark, towering oak trees.", true),
    rabbits: new ForestDetail("rabbits", "Rabbits dashing playfully through the shadowy underbrush.", true),
    deer: new ForestDetail("deer", "Deer grazing peacefully in the sun-dappled forest clearings.", true),
    birds: new ForestDetail("birds", "Woodland birds chirping melodiously in the canopy above.", false),
    trees: new ForestDetail("trees", "Tall, ancient trees casting long shadows across the meandering path.", false),
    roots: new ForestDetail("roots", "The roots of the ancient oaks are exposed like knotted fingers, and beneath them you find faint moon-silver writing etched into the earth.", false),
    stump: new ForestDetail("stump", "A freshly cut oak stump still dripping sap. Someone has been taking more than the forest can replace.", false),
    oak: new ForestDetail("oak", "The central oak is older than the village. It carries the silence of a guardian who has seen too many winters.", false),
    moss: new GameEntity("moss", "A patch of moss glows faintly under the roots, as if the forest is trying to leave a trail for you."),
    spectacles: new GameEntity("spectacles", "Grandmother's spectacles, resting awkwardly on a suspiciously large snout. Tiny sigils are etched around the rims."),
    closet: new GameEntity("closet", "A sturdy wooden closet in the corner of the cottage, its frame carved with the same old sigils.")
};

const npcs = {
    wolf: new NPC(
        "wolf",
        "A wolf with iron-gray fur and a lean, watchful frame—a displaced guardian of the deep woods rather than a simple monster.",
        '"Where are you bound, child? Your grandmother keeps strange hours. If the forest remembers, it remembers her."'
    ),
    woodcutter: new NPC(
        "woodcutter",
        "A hard-faced logger with a bloodstained axe and a greedy stare fixed on the ancient oak canopy; he is stripping the forest faster than it can recover.",
        '"Keep your eyes open, girl. The woods are not sacred to me—only the timber that pays."'
    )
};

const worldMap = {
    forest_path: new Location(
        "forest_path",
        "The Deep, Mysterious Forest Path",
        "Tall trees cast long shadows across the well-trodden path. Squirrels scurry up trees, rabbits dash through the underbrush, and deer graze in clearings. A cunning wolf lurks near the path, while a woodcutter works in the distance.",
        "The crisp scent of pine and fresh earth fills the air.",
        "You hear rustling leaves, melodiously chirping birds, and the distant chop of a woodcutter's axe."
    ),
    cottage_exterior: new Location(
        "cottage_exterior",
        "Grandmother's Quaint Cottage (Outside)",
        "You stand before Grandmother's cottage on the other side of the forest. The house is unusually silent, shrouded in an eerie, deceptive calm. A wooden latch sits on the front door.",
        "A faint trace of woodsmoke and baked bread drifts from the chimney.",
        "An eerie silence hangs over the cottage, broken only by the wind in the trees."
    ),
    cottage_interior: new Location(
        "cottage_interior",
        "Grandmother's Cozy Cottage (Inside)",
        "The aroma of freshly baked bread lingers in the air. A large, disheveled figure lies in Grandmother's bed wearing her nightgown, cap, and spectacles. A wooden closet stands in the corner.",
        "The warm aroma of freshly baked bread contrasts sharply with the scent of a wild predator.",
        "Every creak of the floorboards echoes through the quiet room, along with heavy, raspy breathing from the bed.",
        "The aroma of freshly baked bread lingers in the air. Grandmother sits up in her bed in her nightgown and cap, smiling warmly. A wooden closet stands in the corner."
    )
};

// ============================================================================
// 2. FUNCTIONAL PARADIGM
// ============================================================================
// Wellness is a real score now. A perfect 100 needs the clean route:
//   start 35 + 65 (full basket) = 100.
// Penalties at delivery: -5 per turn dawdling (max -30), -10 for speaking to the
// wolf, -15 if Grandmother had to be rescued from the closet (she gets +10 for
// being freed first). Wolf routes therefore land around 85, dawdling lowers it more.
const WELLNESS_START = 35;
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

const createInitialState = (previousState = null) => Object.freeze({
    location: "forest_path",
    stayedOnPath: true,
    talkedToWolf: false,
    revealedDestination: false,
    forestDelay: 0,
    hummedTune: false,
    warnedWoodcutter: false,
    commotionLevel: 0,
    cluesNoticed: 0,
    cluesSeen: Object.freeze([]),
    wolfSubdued: false,
    grandmotherUntied: false,
    grandmotherWellness: WELLNESS_START,
    inventory: Object.freeze(basketItems.map(item => item.name)),
    factionAffinity: "neutral",
    loopCount: previousState ? previousState.loopCount + 1 : 0,
    memoryFragments: Object.freeze(previousState ? [...previousState.memoryFragments] : []),
    spectaclesTaken: false,
    grandmotherMystic: false,
    standoffChoice: null,
    pactRevealed: false
});

const applyTransition = (currentState, updaterFn) => Object.freeze(updaterFn({ ...currentState }));

const rememberFragment = (fragment) => (state) => {
    if (!fragment || state.memoryFragments.includes(fragment)) return state;
    return { ...state, memoryFragments: Object.freeze([...state.memoryFragments, fragment]) };
};

const lingerInWoods = (state) => ({ ...state, stayedOnPath: false, forestDelay: state.forestDelay + 1 });
const humMelody = (state) => ({ ...state, hummedTune: true, commotionLevel: state.commotionLevel + 1 });
const alertWoodcutter = (state) => ({ ...state, warnedWoodcutter: true, factionAffinity: "woodcutter" });
const speakToStranger = (state) => ({ ...state, talkedToWolf: true, revealedDestination: true, factionAffinity: "forest" });
const moveTo = (location) => (state) => ({ ...state, location });

// Each clue (eyes / ears / teeth) counts once; the count is derived from the set.
const noticeClue = (clue) => (state) => {
    if (state.cluesSeen.includes(clue)) return state;
    const cluesSeen = Object.freeze([...state.cluesSeen, clue]);
    return { ...state, cluesSeen, cluesNoticed: cluesSeen.length };
};

const subdueWolfAndRescue = (state) => ({
    ...state,
    wolfSubdued: true,
    inventory: Object.freeze(state.inventory.filter(item => item !== "wine"))
});

const untieGrandmotherFromCloset = (state) => ({
    ...state,
    grandmotherUntied: true,
    grandmotherWellness: clamp(state.grandmotherWellness + 10, 0, 100),
    grandmotherMystic: true,
    memoryFragments: state.grandmotherMystic
        ? state.memoryFragments
        : Object.freeze([...state.memoryFragments, "The real Grandmother is an exiled witch; her pact with the forest bound this day."])
});

const deliveryPenalty = (state) =>
    Math.min(30, state.forestDelay * 5) +
    (state.talkedToWolf ? 10 : 0) +
    (state.wolfSubdued ? 15 : 0);

const deliverRemedies = (state, items) => {
    const boost = items
        .filter(item => state.inventory.includes(item.name))
        .reduce((sum, item) => sum + item.wellnessPoints, 0);
    const magicalBoost = state.grandmotherMystic && state.inventory.includes("remedies") ? 10 : 0;
    const spectacleBoost = state.spectaclesTaken ? 5 : 0;
    return {
        ...state,
        grandmotherWellness: clamp(state.grandmotherWellness + boost + magicalBoost + spectacleBoost - deliveryPenalty(state), 0, 100),
        inventory: Object.freeze(state.inventory.filter(item => !items.some(delivered => delivered.name === item))),
        memoryFragments: Object.freeze([
            ...state.memoryFragments,
            "The remedies were never ordinary medicine; they were a key to the forest's oldest bargains."
        ])
    };
};

const isWoodcutterAlerted = (s) => s.warnedWoodcutter || (s.hummedTune && s.commotionLevel >= 2);

// ============================================================================
// 3. LOGIC PARADIGM: Prolog Chaos Engine
// ============================================================================
const CHAOS_RULES = `
    % Wolf beats Red to the cottage if she tells him OR dawdles off-path twice
    wolf_infiltrated :- talked_to_wolf(true), revealed_destination(true).
    wolf_infiltrated :- stayed_on_path(false), forest_delay(D), D >= 2.

    % The wolf is trying to escape the woodcutter's threat, not simply hunt Red.
    wolf_seeking_refuge :- faction_affinity(forest), talked_to_wolf(true).
    wolf_seeking_refuge :- faction_affinity(forest), stayed_on_path(false), forest_delay(D), D >= 2.

    % Woodcutter is in earshot if warned, or Red hummed repeatedly
    woodcutter_alerted :- warned_woodcutter(true).
    woodcutter_alerted :- hummed_tune(true), commotion_level(C), C >= 2.

    % A forest-aligned playthrough can end in a tense stand-off when the wolf and woodcutter meet at the cottage.
    standoff_at_cottage :- wolf_seeking_refuge, woodcutter_alerted.

    % The loop ends only when Grandmother is free, her remedies are delivered,
    % the pact is understood, and the wolf and woodcutter both accept its terms.
    fulfilled_pact :- pact_revealed(true), grandmother_mystic(true),
                      grandmother_untied(true), basket_delivered(true),
                      standoff_choice(pact), faction_affinity(forest),
                      wolf_subdued(false).

    preemptive_rescue :- wolf_infiltrated, warned_woodcutter(true), clues_noticed(N), N >= 1.
    classic_rescue    :- wolf_infiltrated, clues_noticed(N), N >= 3, woodcutter_alerted.
    unrescued_ambush  :- wolf_infiltrated, clues_noticed(N), N >= 3,
                         \\+ woodcutter_alerted, faction_affinity(neutral).
    safe_reunion      :- \\+ wolf_infiltrated.

    story_outcome(true_ending)                 :- fulfilled_pact, !.
    story_outcome(grandmother_saved_and_untied) :- grandmother_untied(true), !.
    story_outcome(standoff)                     :- standoff_at_cottage, !.
    story_outcome(preemptive_woodcutter_rescue) :- preemptive_rescue, !.
    story_outcome(classic_woodcutter_rescue)    :- classic_rescue, !.
    story_outcome(wolf_overwhelms_red)          :- unrescued_ambush, !.
    story_outcome(wolf_waiting_in_disguise)     :- wolf_infiltrated, !.
    story_outcome(peaceful_visit)               :- safe_reunion, !.
    story_outcome(uncertain).
`;

const evaluateChaosRules = (state) =>
    new Promise((resolve, reject) => {
        const session = pl.create();
        const facts = `
            stayed_on_path(${state.stayedOnPath}).
            talked_to_wolf(${state.talkedToWolf}).
            revealed_destination(${state.revealedDestination}).
            forest_delay(${state.forestDelay}).
            hummed_tune(${state.hummedTune}).
            warned_woodcutter(${state.warnedWoodcutter}).
            commotion_level(${state.commotionLevel}).
            clues_noticed(${state.cluesNoticed}).
            grandmother_untied(${state.grandmotherUntied}).
            faction_affinity(${state.factionAffinity || 'neutral'}).
            grandmother_mystic(${state.grandmotherMystic}).
            pact_revealed(${state.pactRevealed}).
            standoff_choice(${state.standoffChoice ? `'${state.standoffChoice}'` : 'none'}).
            basket_delivered(${basketItems.every(item => !state.inventory.includes(item.name))}).
            wolf_subdued(${state.wolfSubdued}).
        `;
        session.consult(facts + CHAOS_RULES, {
            success: () => {
                session.query("story_outcome(Outcome).", {
                    success: () => {
                        session.answer(answer => {
                            if (pl.type.is_error(answer)) reject(new Error(pl.format_answer(answer)));
                            else if (pl.type.is_substitution(answer)) resolve(answer.lookup("Outcome").id);
                            else resolve("uncertain");
                        });
                    },
                    error: reject
                });
            },
            error: reject
        });
    });

// ============================================================================
// 4. IMPERATIVE PARADIGM: Command table & Route Handlers
// ============================================================================
// Prolog resolves every command to a CANONICAL verb/target (the keys of LEXICON),
// so the table below is keyed by those and holds no alias lists of its own.
const CLUE_TEXT = {
    eyes: '"Grandmother, what big eyes you have!"\n"The better to see you with, my dear," replies a forced, uncharacteristically rough voice.',
    ears: '"Oh, Grandmother, what big ears you have!"\n"The better to hear you with, my dear," comes the unsettling response.',
    teeth: '"And, Grandmother, what big teeth you have!"\n"The better to eat you with!" the voice growls.'
};
const CLUES = new Set(Object.keys(CLUE_TEXT));
const LOOK_AROUND = new Set(["around", "path", "cottage"]);

const describeLocation = (state, priorOutcome) => {
    const loc = worldMap[state.location];
    const friendly = priorOutcome === "peaceful_visit" || state.grandmotherUntied;
    const base = friendly && loc.peacefulDescription ? loc.peacefulDescription : loc.examine();
    return `${base}\n\n${describeEnvironmentalLore(state)}`;
};

const summarizeEnding = (state) => {
    if (state.pactRevealed && state.grandmotherMystic && state.grandmotherUntied &&
        basketItems.every(item => !state.inventory.includes(item.name)) && state.standoffChoice === "pact" &&
        state.factionAffinity === "forest" && !state.wolfSubdued) {
        return "TRUE ENDING — Grandmother's forest pact is fulfilled: she is free and healed, the wolf keeps his ancient charge, and the woodcutter accepts wine, lays down his axe, and lets the felling be undone. The heart oak stands again. The borrowed day finally moves forward; this loop ends.";
    }
    if (state.standoffChoice === "pact") {
        return "The wolf and woodcutter accept a temporary truce for the wine, but the old pact remains incomplete. The day will turn again until Grandmother is free, the remedies are delivered, and the forest's terms are understood.";
    }
    if (state.standoffChoice === "wolf") {
        return "You choose the wolf and the forest. The axe falls short of the old oath, and the woods breathe again as a living thing rather than a cut-down ruin.";
    }
    if (state.standoffChoice === "woodcutter") {
        return "You choose the woodcutter, and the forest pays for it with silence. The trees do not forgive a blade that was already raised too early.";
    }
    if (state.standoffChoice === "grandmother") {
        return "You choose to protect grandmother and the fragile boundary between fear and mercy. The forest does not bow, but it lets the day end without a blood sacrifice.";
    }
    if (state.grandmotherUntied && state.factionAffinity === "forest") {
        return "You break the loop by refusing the woodcutter's greed and listening to the forest itself. The old cottage is no longer a trap, but a threshold.";
    }
    if (state.grandmotherUntied && state.factionAffinity === "woodcutter") {
        return "You survive the forest by siding with force, but the cost is bitter: the woods fall silent under the axe, and memory refuses to be healed.";
    }
    if (state.factionAffinity === "forest" && state.warnedWoodcutter) {
        return "The forest and the woodcutter collide at the cottage door. You stand between them in the threshold of a new story, where the wolf is not merely a monster but a guardian with a claim to the land.";
    }
    if (state.grandmotherWellness >= 85) {
        return "The basket succeeds, and the remedies carry the day. Red leaves the cottage with a gentler understanding of the forest and the danger it keeps.";
    }
    if (state.wolfSubdued) {
        return "The wolf is subdued, the cottage is saved, but the truth of the forest remains unsettled. The day ends in survival, not peace.";
    }
    return "The day ends in silence. Even as the path reopens, the forest still remembers every failed version of this story.";
};

const describeEnvironmentalLore = (state) => {
    const base = [
        "The forest carries more than weather; it carries memory.",
        "Rosemary and iron hang in the air whenever the cottage is near.",
        "Every tree seems to listen, and every clearing keeps a secret."
    ];
    if (state.spectaclesTaken) {
        base.push("The spectacles reveal matching sigils on the cottage walls, closet, and oak roots: Grandmother bound this day in a forest pact.");
    }
    if (state.location === "forest_path") {
        base.push("Near the roots, a trail of pale moss and stripped bark suggests the forest has been leaving clues for someone who knows how to read them.");
    }
    if (state.factionAffinity === "forest") {
        base.push("You begin to hear the forest as a voice, not a threat.");
    }
    if (state.factionAffinity === "woodcutter") {
        base.push("The woodcutter's hunger has marked the land itself, and the forest recoils from every chopped trunk.");
    }
    return base.join("\n");
};

const goToCottage = (state) => {
    const s = applyTransition(state, moveTo("cottage_exterior"));
    return { state: s, text: worldMap.cottage_exterior.examine() };
};

const resolveStandoffChoice = (command, state) => {
    if (state.location !== "cottage_interior" || state.standoffChoice !== null) return null;
    const text = command.toLowerCase();
    if (text.includes("help wolf") || text.includes("stand with wolf") || text.includes("choose wolf") || text.includes("side with wolf") || text.includes("protect forest") || text.includes("help the wolf")) return "wolf";
    if (text.includes("help woodcutter") || text.includes("stand with woodcutter") || text.includes("choose woodcutter") || text.includes("side with woodcutter") || text.includes("help the woodcutter") || text.includes("let the woodcutter in")) return "woodcutter";
    if (text.includes("protect grandmother") || text.includes("save grandmother") || text.includes("protect the grandmother") || text.includes("guard grandmother") || text.includes("choose grandmother")) return "grandmother";
    return null;
};

const handleStandoffChoice = (state, choice) => {
    const memoryMap = {
        wolf: "You choose the wolf and the forest. The old oath is not a lie: the woodcutter is the threat, not the guardian.",
        woodcutter: "You choose the axe and the road to survival. The forest remembers this choice as a wound.",
        grandmother: "You choose to protect grandmother. You will not let the forest or the axe claim her life tonight."
    };
    const nextState = applyTransition(state, st => ({
        ...st,
        standoffChoice: choice,
        factionAffinity: choice === "grandmother" ? "neutral" : (choice === "woodcutter" ? "woodcutter" : "forest"),
        memoryFragments: Object.freeze([...st.memoryFragments, memoryMap[choice]])
    }));
    return {
        state: nextState,
        text: choice === "wolf"
            ? "You step between the wolf and the woodcutter, and the forest stirs around you. The wolf is not the enemy tonight; the hunger in the axe is."
            : choice === "woodcutter"
                ? "You call the woodcutter in and let the axe settle the matter. The forest recoils, and the day's old bargain breaks under steel."
                : "You protect grandmother and keep the threshold closed. The wolf retreats, the woodcutter is forced back, and the night ends without another death."
    };
};

const handlers = {
    listen: ({ state }) => ({ text: worldMap[state.location].sounds }),

    smell: ({ state }) => ({ text: worldMap[state.location].smells }),

    hum: ({ state }) => {
        const s = applyTransition(state, humMelody);
        return {
            state: s,
            text: s.commotionLevel >= 2
                ? "You hum louder. The tune carries through the trees—the woodcutter has surely heard you by now."
                : "You hum a cheerful tune softly to yourself. It might carry to the woodcutter's ears... if you keep it up."
        };
    },

    watch: ({ state, target }) => {
        if (state.location !== "forest_path") return { text: "There are no forest creatures here." };
        const entity = forestEntities[target];
        if (entity instanceof ForestDetail && entity.causesDelay) {
            const s = applyTransition(state, lingerInWoods);
            return {
                state: s,
                text: `${entity.examine()}\nYou linger off the path, losing precious time (Forest Delay: ${s.forestDelay}).`
            };
        }
        if (entity instanceof ForestDetail) {
            return { text: `${entity.examine()}\nYou watch them quietly without straying from the path.` };
        }
        return { text: `You watch the ${target && target !== "around" ? target : "surroundings"} quietly.` };
    },

    examine: ({ state, target, priorOutcome }) => {
        const inCottage = state.location === "cottage_interior";
        const peaceful = priorOutcome === "peaceful_visit";

        if (!target || LOOK_AROUND.has(target)) {
            return { text: describeLocation(state, priorOutcome) };
        }
        if (target === "basket") {
            const items = basketItems.filter(i => state.inventory.includes(i.name));
            return {
                text: items.length === 0
                    ? "Your basket is empty; Grandmother has received all her treats and herbal remedies."
                    : "Your basket contains:\n" + items.map(i => `• ${i.name.toUpperCase()}: ${i.examine()}`).join("\n")
            };
        }
        if (inCottage && target === "spectacles") {
            const s = applyTransition(state, st => ({
                ...st,
                spectaclesTaken: true,
                inventory: Object.freeze([...st.inventory.filter(item => item !== "spectacles"), "spectacles"]),
                memoryFragments: st.memoryFragments.includes("The spectacle rims bear the same forest sigils carved into the cottage.")
                    ? st.memoryFragments
                    : Object.freeze([...st.memoryFragments, "The spectacle rims bear the same forest sigils carved into the cottage."])
            }));
            return {
                state: s,
                text: "The spectacles are impossibly warm. Fine sigils circle their rims, matching the marks carved into the closet frame. Through the lenses, the cottage walls seem to hold a second story."
            };
        }
        if (inCottage && target === "walls") {
            if (!state.spectaclesTaken) {
                return { text: "The cottage walls look bare. The spectacles on the bed may reveal what the naked eye cannot." };
            }
            if (state.pactRevealed) {
                return { text: "Through the spectacles, the wall sigils resolve into the pact: Grandmother bound this day so the felling could be undone; the wolf guards the old oaks, and the woodcutter receives wine as his due if he lays down his axe." };
            }
            const s = applyTransition(state, st => ({
                ...st,
                pactRevealed: true,
                memoryFragments: Object.freeze([...st.memoryFragments, "The wall sigils reveal Grandmother's pact: undo the felling, protect the old oaks, and give the woodcutter wine if he lays down his axe."])
            }));
            return {
                state: s,
                text: "Through the spectacles, sigils bloom across the cottage walls. Grandmother bound this day so the felling could be undone: the wolf must keep his charge over the old oaks, while the woodcutter receives wine as his due if he lays down his axe. The loop will turn until the pact is kept."
            };
        }
        if (inCottage && target === "closet") {
            if (state.grandmotherUntied) {
                return { text: "The real Grandmother stands free. Old sigils mark her wrists and the closet frame; she is the witch who bound this day to the forest pact." };
            }
            return { text: `${forestEntities.closet.examine()} Something living stirs inside.` };
        }
        if (inCottage && CLUES.has(target)) {
            if (peaceful) return { text: `Grandmother smiles warmly. Her ${target} look perfectly ordinary—nothing amiss at all.` };
            if (state.wolfSubdued) return { text: "The wolf has been subdued. There's nothing more to learn from the bed." };
            const s = applyTransition(state, noticeClue(target));
            let text = CLUE_TEXT[target];
            if (s.cluesNoticed >= 3) {
                text += "\nThe disguise falls away—the wolf leaps from the bed!";
            } else if (s.cluesNoticed === 2 && !isWoodcutterAlerted(s)) {
                text += "\nA chill runs down your spine: if this goes wrong, no one is close enough to hear you. Perhaps make some noise first ('hum tune').";
            }
            return { state: s, text };
        }
        if (inCottage && (target === "figure" || target === "grandmother")) {
            if (peaceful) return { text: "Grandmother beams at you from her bed, a little pale from her cold but perfectly herself." };
            if (state.grandmotherUntied) return { text: "The real Grandmother is free and holding your hand; old pact sigils mark her wrists." };
            if (state.wolfSubdued) return { text: "The subdued wolf lies where the 'Grandmother' once was. The real one is in the closet!" };
            return {
                text: "The figure in the bed is the wolf in Grandmother's nightclothes, not Grandmother herself. Its disguise is plain cloth and coarse fur; no witch's sigils mark it. The real Grandmother is bound in the closet."
            };
        }
        if (forestEntities[target]) return { text: forestEntities[target].examine() };
        if (npcs[target]) return { text: npcs[target].examine() };
        return { text: `You look closely at the ${target}, keeping your mother's wise words in mind.` };
    },

    talk: ({ state, target }) => {
        if (state.location === "cottage_interior") return { text: "There is no one to speak with here except the figure in the bed." };
        if (state.location !== "forest_path") return { text: "There is no one here to talk to." };
        if (target === "wolf") {
            return {
                state: applyTransition(state, st => rememberFragment("The wolf is not merely hungry; he is guarding the forest.")(speakToStranger(st))),
                text: `${npcs.wolf.speak()}\nOblivious to the danger, you reply, "I'm off to visit my grandmother and bring her some treats at her cottage on the other side of the forest."\nThe wolf's eyes sharpen with recognition. He knows where that cottage sits—and why the forest seems to recoil from it.`
            };
        }
        if (target === "woodcutter") {
            return {
                state: applyTransition(state, st => rememberFragment("The woodcutter profits from the forest's ruin.")(alertWoodcutter(st))),
                text: `${npcs.woodcutter.speak()}\nThe woodcutter grins with predatory confidence and promises to keep watch near Grandmother's cottage—so long as the tree-fall keeps paying.`
            };
        }
        return { text: "Specify who you want to talk to: 'talk to wolf' or 'talk to woodcutter'." };
    },

    wander: ({ state }) => {
        if (state.location !== "forest_path") {
            return { text: "There is nowhere to wander off to from here." };
        }
        const s = applyTransition(state, lingerInWoods);
        return {
            state: s,
            text: `Ignoring your mother's stern advice to stay on the path, you wander into the shadowy clearings. Fresh-cut oak leaves a streak of white logger's chalk on your red cloak (Forest Delay: ${s.forestDelay}).`
        };
    },

    walk: ({ state, target }) => {
        if (target === "back") return handlers.back({ state });
        if (state.location === "forest_path") return goToCottage(state);
        if (state.location === "cottage_exterior") return { text: "The door is latched. Try 'knock on door' or 'lift latch' to enter." };
        return { text: "You are already inside Grandmother's cottage." };
    },

    back: ({ state }) => {
        if (state.location === "cottage_exterior") {
            return {
                state: applyTransition(state, moveTo("forest_path")),
                text: "You retrace your steps to the forest path.\n" + worldMap.forest_path.examine()
            };
        }
        if (state.location === "forest_path") return { text: "You are already on the forest path." };
        return { text: "The door has swung shut behind you. There's no leaving until this is resolved." };
    },

    open: async ({ state, target, priorOutcome }) => {
        const loc = state.location;

        if (loc === "forest_path") {
            if (target === "cottage" || target === "latch") return goToCottage(state);
            return { text: "There is nothing here to open. The cottage lies ahead: try 'walk to cottage'." };
        }

        if (loc === "cottage_exterior") {
            if (!["latch", "cottage", "around"].includes(target)) {
                return { text: "Specify what you want to open or lift (e.g., 'lift latch' or 'knock on door')." };
            }
            const s = applyTransition(state, moveTo("cottage_interior"));
            const outcome = await evaluateChaosRules(s);
            return {
                state: s,
                text: outcome === "peaceful_visit"
                    ? 'Grandmother warmly invites you inside! Since you stayed on the path and ignored strangers, the wolf never beat you here. Use "give basket" to deliver her treats and herbal remedies!'
                    : 'A hoarse voice calls out, "Lift the latch and come in, dear." You push the door open and step inside.\n' + worldMap.cottage_interior.examine()
            };
        }

        // cottage_interior
        if (target === "closet" || target === "grandmother") {
            if (state.grandmotherUntied) return { text: "Grandmother is already free." };
            if (priorOutcome === "peaceful_visit") return { text: "The closet holds nothing but Grandmother's spare linens." };
            if (state.wolfSubdued || state.standoffChoice === "pact") {
                const pactResolution = state.standoffChoice === "pact";
                return {
                    state: applyTransition(state, untieGrandmotherFromCloset),
                    text: pactResolution
                        ? "The wolf steps aside when you speak the pact's terms. You open the sigil-carved closet and free the real Grandmother, an exiled witch whose wrists bear the forest's old runes. She confirms the loop began with her promise to undo the felling. Now deliver the remedies to complete the pact."
                        : "With the wolf subdued, you open the sigil-carved closet and carefully untie Grandmother. The real Grandmother is an exiled witch, her wrists marked by the old forest pact that bound this day. Now type 'give basket' to deliver her remedies and treats."
                };
            }
            return { text: "You cannot reach the closet while the figure in the bed watches your every move!" };
        }
        return { text: "Specify what you want to open (e.g., 'open closet')." };
    },

    give: ({ state, target, priorOutcome }) => {
        if (state.location !== "cottage_interior") return { text: "You must be inside Grandmother's cottage to deliver the basket." };
        if (target === "wolf") return { text: "You would never hand your mother's treats to a stranger with teeth like that." };
        if (target === "woodcutter") {
            if (priorOutcome !== "standoff" || state.standoffChoice !== null) {
                return { text: "The woodcutter is not here to bargain. There is no point offering him wine now." };
            }
            if (!state.pactRevealed) {
                return { text: "The woodcutter refuses to bargain blindly. Uncover the cottage's old terms before offering him anything." };
            }
            if (!state.inventory.includes("wine")) {
                return { text: "You have no wine left to offer. The woodcutter turns away; this truce cannot be sealed." };
            }
            const s = applyTransition(state, st => ({
                ...st,
                inventory: Object.freeze(st.inventory.filter(item => item !== "wine")),
                standoffChoice: "pact",
                factionAffinity: "forest",
                memoryFragments: Object.freeze([...st.memoryFragments, "The woodcutter accepts the wine and agrees to spare the heart oak."])
            }));
            return {
                state: s,
                text: "You offer the woodcutter the wine. He accepts it as his due and lays down his axe; the wolf lowers his hackles but keeps his watch. The bargain is made, but the pact will not be fulfilled until Grandmother is free and receives the remedies."
            };
        }
        const remainingBasketItems = basketItems.filter(item => state.inventory.includes(item.name));
        if (remainingBasketItems.length === 0) return { text: "Your basket is already empty—Grandmother has everything you brought." };
        if (priorOutcome === "peaceful_visit" || state.grandmotherUntied) {
            const s = applyTransition(state, st => deliverRemedies(st, basketItems));
            const perfect = s.grandmotherWellness === 100;
            const delivered = remainingBasketItems.map(item => item.name);
            return {
                state: s,
                text: `You hand over ${delivered.join(", ")}. Grandmother's spirits and health soar! Final UN SDG Goal 3 Wellness Score: ${s.grandmotherWellness}%!` +
                    (perfect ? "" : "\nA perfect 100% needs the clean route: stay on the path, never speak to the stranger, and arrive before the wolf does.") +
                    `\n\n${summarizeEnding(s)}`
            };
        }
        if (state.wolfSubdued) return { text: "Grandmother is still tied up in the closet! Free her first." };
        return { text: "Something feels dangerously wrong with the figure in the bed! Examine her 'eyes', 'ears', or 'teeth' first." };
    },

    wear: ({ state, target }) => {
        if (target !== "spectacles") return { text: "You can only wear the enchanted spectacles." };
        if (!state.spectaclesTaken) return { text: "The spectacles are not in your possession yet." };
        const s = applyTransition(state, st => ({
            ...st,
            memoryFragments: Object.freeze([...st.memoryFragments, "Wearing the spectacles reveals hidden truths in the world as though it were writing in moonlight."])
        }));
        return {
            state: s,
            text: "You set the enchanted spectacles on your face. The world sharpens into pale glyphs and hidden paths; the cottage seems less like a home and more like a riddle the forest has been trying to solve for years."
        };
    },

    take: ({ state, target }) => handlers.wear({ state, target }),

    help: () => ({
        text: [
            "Available Commands:",
            "• Sensory & Exploration: 'look around', 'listen', 'smell', 'hum tune', 'examine basket', 'examine cloak'",
            "• Forest Interactions: 'watch squirrels/rabbits/deer', 'watch roots', 'watch oak', 'talk to woodcutter', 'talk to wolf', 'wander off path'",
            "• Movement: 'walk to cottage', 'go back'",
            "• Cottage Progression: 'lift latch', 'examine spectacles', 'wear spectacles', 'examine walls', 'examine eyes/ears/teeth'",
            "• Standoff Choices: 'choose wolf', 'choose woodcutter', 'protect grandmother', or uncover the pact and 'give woodcutter' wine",
            "• Resolution: 'open closet', 'untie grandmother', 'give basket'"
        ].join("\n")
    })
};

const runCommand = async (userId, command) => {
    let state = (await getPlayerStateFromDB(userId)) || createInitialState();

    // --- ML layer: BPE tokenize (+typo snapping) -> Prolog intent ---
    const enc = encodeCommand(command);
    const { verb, target } = await resolveIntentWithProlog(enc.words);
    const resolved = verb !== "unknown";
    const corrected = enc.corrections.map(c => `${c.from}→${c.to}`).join(", ");
    const mlTelemetry = {
        subwords: enc.subwords,
        tokenIds: enc.tokenIds,
        corrections: enc.corrections,
        resolvedIntent: resolved
            ? `${verb.toUpperCase()} -> ${target.toUpperCase()}${corrected ? ` (fixed: ${corrected})` : ""}`
            : "UNRESOLVED"
    };

    const priorOutcome = await evaluateChaosRules(state);
    if (priorOutcome === "wolf_overwhelms_red") {
        return {
            response: `The wolf has already gotten you. Press 'Reset Timeline' to try again. ${state.loopCount > 0 ? `You remember the last loop: ${state.memoryFragments[state.memoryFragments.length - 1] || 'The forest keeps replaying its own lesson.'}` : 'The forest still feels strangely familiar.'}`,
            chaosOutcome: priorOutcome,
            state,
            mlTelemetry
        };
    }

    let narrativeResponse = "Unrecognized command. Type 'help' to see all supported commands.";

    const standoffChoice = resolveStandoffChoice(command, state);
    if (standoffChoice && priorOutcome === "standoff") {
        const result = handleStandoffChoice(state, standoffChoice);
        const chaosOutcome = "standoff";
        narrativeResponse = result.text + `\n\n[CHOICE: ${standoffChoice.toUpperCase()}]`;
        state = result.state;
        await savePlayerStateToDB(userId, state, chaosOutcome);
        runSQL(`INSERT INTO chaos_logs (user_id, command, resulting_outcome) VALUES (?, ?, ?)`,
            [userId, command, chaosOutcome]).catch(err => console.error("chaos_logs insert failed:", err.message));
        return { response: narrativeResponse, chaosOutcome, state, mlTelemetry };
    }

    // "back" is a target in the lexicon, so "go back" / "return" work with any verb.
    const key = target === "back" ? "back" : verb;
    const handler = handlers[key];

    if (resolved && handler) {
        const result = await handler({ state, target, priorOutcome });
        narrativeResponse = result.text;
        if (result.state) state = result.state;
    }

    // Re-evaluate Prolog after the command's state transition
    const chaosOutcome = await evaluateChaosRules(state);

    if (state.location === "cottage_interior" && !state.wolfSubdued) {
        if (chaosOutcome === "standoff") {
            narrativeResponse += "\n\n[PROLOG OUTCOME: STANDOFF]\nThe wolf has the forest at his back, but the woodcutter is already at the cottage door. You stand between predator and logger in the threshold of the old bargain. The final choice is no longer about a simple rescue—it is about who keeps the forest alive when the story turns on you.";
        } else if (chaosOutcome === "preemptive_woodcutter_rescue") {
            const price = state.inventory.includes("wine")
                ? "he takes the wine from your basket as payment"
                : "with no wine left, he exacts payment in a promise to keep quiet about the oak";
            state = applyTransition(state, subdueWolfAndRescue);
            narrativeResponse += `\n\n[PROLOG OUTCOME: PREEMPTIVE RESCUE]\nThe woodcutter arrives because you warned him. He saves you, but ${price} and makes you swear not to interfere with his logging. Type 'open closet' to free Grandmother.`;
        } else if (chaosOutcome === "classic_woodcutter_rescue") {
            const price = state.inventory.includes("wine")
                ? "he takes the wine from your basket as payment"
                : "with no wine left, he exacts payment in a promise to keep quiet about the oak";
            state = applyTransition(state, subdueWolfAndRescue);
            narrativeResponse += `\n\n[PROLOG OUTCOME: TRANSACTIONAL RESCUE]\nThe woodcutter hears the commotion and subdues the wolf. He saves you, but ${price} and makes you swear not to interfere with his logging. Type 'open closet' to untie Grandmother.`;
        } else if (chaosOutcome === "wolf_overwhelms_red") {
            narrativeResponse += "\n\n[PROLOG OUTCOME: AMBUSH]\nYou arrive with no answer to the forest's pact. The wolf mistakes the unanswered marks on your cloak for the logger's sign and believes you came to finish felling the heart oak. Sworn to stop anyone carrying that mark, he overwhelms you. GAME OVER—press 'Reset Timeline' to try again.";
        }
    }

    await savePlayerStateToDB(userId, state, chaosOutcome);
    runSQL(`INSERT INTO chaos_logs (user_id, command, resulting_outcome) VALUES (?, ?, ?)`,
        [userId, command, chaosOutcome]).catch(err => console.error("chaos_logs insert failed:", err.message));

    return { response: narrativeResponse, chaosOutcome, state, mlTelemetry };
};

const WELCOME_TEXT = "Welcome to LITTLE RED RIDING HOOD: CHAOS IN THE DEEP WOODS.\nYour mother hands you a basket of bread, sweet wine, sweet cakes, and herbal remedies for your ailing Grandmother.\n\"Stay on the path and avoid talking to strangers!\" she warns, but the words have the shape of an old omen.\nThis is not the first time the forest has swallowed this day. Somewhere in the cottage, an old pact is keeping the day from moving forward.\nType 'help' for commands, or 'look around' to begin.";

const resolveUserId = (raw) => {
    const userId = raw === undefined ? DEFAULT_USER : raw;
    return typeof userId === "string" && USER_ID_RE.test(userId) ? userId : null;
};
const badUser = (res) => res.status(400).json({ error: "Invalid account ID (use 1-40 letters, digits, '_' or '-')." });

app.post('/api/command', async (req, res) => {
    const userId = resolveUserId(req.body?.userId);
    if (!userId) return badUser(res);
    const command = req.body?.command;
    if (typeof command !== "string" || command.length > MAX_COMMAND_LENGTH) {
        return res.status(400).json({ error: `Command must be text of at most ${MAX_COMMAND_LENGTH} characters.` });
    }
    try {
        await dbReady;
        res.json(await withUserLock(userId, () => runCommand(userId, command)));
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: error.message });
    }
});

// Load (without creating) a player's saved timeline so the UI can resume it.
app.get('/api/state', async (req, res) => {
    const userId = resolveUserId(req.query.userId);
    if (!userId) return badUser(res);
    try {
        await dbReady;
        const saved = await withUserLock(userId, () => getPlayerStateFromDB(userId));
        const state = saved || createInitialState();
        res.json({
            response: saved
                ? `Resumed saved timeline for '${userId}'. Type 'look around' to get your bearings, or press Reset Timeline to start over.`
                : WELCOME_TEXT,
            chaosOutcome: await evaluateChaosRules(state),
            state,
            isNew: !saved
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/reset', async (req, res) => {
    const userId = resolveUserId(req.body?.userId);
    if (!userId) return badUser(res);
    try {
        await dbReady;
        const previousState = await withUserLock(userId, () => getPlayerStateFromDB(userId));
        const initialState = createInitialState(previousState);
        const outcome = await evaluateChaosRules(initialState);
        await withUserLock(userId, () => savePlayerStateToDB(userId, initialState, outcome));
        const rememberText = previousState && previousState.memoryFragments.length
            ? `You carry the memory of the previous loop: ${previousState.memoryFragments[previousState.memoryFragments.length - 1]}`
            : "Grandmother's old pact has bound the day in a loop: the felling must be undone, the forest protected, and the woodcutter's due fairly paid.";
        res.json({
            response: `Timeline reset. The path opens again, but it does not feel new. ${rememberText}\nMother hands you the basket of bread, sweet wine, sweet cakes, and herbal remedies: 'Stay on the path and avoid talking to strangers!' Type 'help' for commands.`,
            chaosOutcome: outcome,
            state: initialState
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: error.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Multi-Paradigm Zork Server running on http://localhost:${PORT}`));
