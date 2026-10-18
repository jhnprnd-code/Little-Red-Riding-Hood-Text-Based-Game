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
const db = new sqlite3.Database(process.env.GAME_DB_PATH || path.join(__dirname, 'game_data.db'));

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
                memory_keys TEXT DEFAULT '[]',
                endings_seen TEXT DEFAULT '[]',
                rosemary_held INTEGER DEFAULT 1,
                ritual_ready INTEGER DEFAULT 0,
                ritual_answered INTEGER DEFAULT 0,
                ending_id TEXT DEFAULT NULL,
                game_over_true INTEGER DEFAULT 0,
                rescue_type TEXT DEFAULT NULL,
                mark_disguised INTEGER DEFAULT 0,
                spectacles_taken INTEGER DEFAULT 0,
                spectacles_worn INTEGER DEFAULT 0,
                grandmother_mystic INTEGER DEFAULT 0,
                standoff_choice TEXT DEFAULT NULL,
                pact_revealed INTEGER DEFAULT 0,
                delivery_penalty_applied INTEGER DEFAULT 0
            )
        `, async (err) => {
            if (err) return reject(err);
            try {
                await ensureColumn('player_sessions_v3', 'faction_affinity', "TEXT DEFAULT 'neutral'");
                await ensureColumn('player_sessions_v3', 'loop_count', 'INTEGER DEFAULT 0');
                await ensureColumn('player_sessions_v3', 'memory_fragments', "TEXT DEFAULT '[]'");
                await ensureColumn('player_sessions_v3', 'memory_keys', "TEXT DEFAULT '[]'");
                await ensureColumn('player_sessions_v3', 'endings_seen', "TEXT DEFAULT '[]'");
                await ensureColumn('player_sessions_v3', 'rosemary_held', 'INTEGER DEFAULT 1');
                await ensureColumn('player_sessions_v3', 'ritual_ready', 'INTEGER DEFAULT 0');
                await ensureColumn('player_sessions_v3', 'ritual_answered', 'INTEGER DEFAULT 0');
                await ensureColumn('player_sessions_v3', 'ending_id', 'TEXT DEFAULT NULL');
                await ensureColumn('player_sessions_v3', 'game_over_true', 'INTEGER DEFAULT 0');
                await ensureColumn('player_sessions_v3', 'rescue_type', 'TEXT DEFAULT NULL');
                await ensureColumn('player_sessions_v3', 'mark_disguised', 'INTEGER DEFAULT 0');
                await ensureColumn('player_sessions_v3', 'spectacles_taken', 'INTEGER DEFAULT 0');
                await ensureColumn('player_sessions_v3', 'spectacles_worn', 'INTEGER DEFAULT 0');
                await ensureColumn('player_sessions_v3', 'grandmother_mystic', 'INTEGER DEFAULT 0');
                await ensureColumn('player_sessions_v3', 'standoff_choice', 'TEXT DEFAULT NULL');
                await ensureColumn('player_sessions_v3', 'pact_revealed', 'INTEGER DEFAULT 0');
                await ensureColumn('player_sessions_v3', 'delivery_penalty_applied', 'INTEGER DEFAULT 0');
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
                memoryKeys: Object.freeze([...new Set([
                    ...safeJsonParse(row.memory_keys, []),
                    ...(row.rosemary_held === 0 ? [] : ["rosemary"])
                ])]),
                endingsSeen: Object.freeze(safeJsonParse(row.endings_seen, [])),
                rosemaryHeld: row.rosemary_held === null ? true : Boolean(row.rosemary_held),
                ritualReady: Boolean(row.ritual_ready),
                ritualAnswered: Boolean(row.ritual_answered),
                endingId: row.ending_id || null,
                gameOverTrue: Boolean(row.game_over_true),
                rescueType: row.rescue_type || null,
                markDisguised: Boolean(row.mark_disguised),
                endingCatalog: ENDING_CATALOG,
                spectaclesTaken: Boolean(row.spectacles_taken),
                spectaclesWorn: Boolean(row.spectacles_worn),
                grandmotherMystic: Boolean(row.grandmother_mystic),
                standoffChoice: row.standoff_choice || null,
                pactRevealed: Boolean(row.pact_revealed),
                deliveryPenaltyApplied: Boolean(row.delivery_penalty_applied)
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
            memory_keys, endings_seen, rosemary_held, ritual_ready, ritual_answered,
            ending_id, game_over_true, rescue_type, mark_disguised,
            spectacles_taken, spectacles_worn, grandmother_mystic, standoff_choice, pact_revealed,
            delivery_penalty_applied
        ) VALUES (
            ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
            ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
            ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        )
    `, [
        userId, s.location,
        s.stayedOnPath ? 1 : 0, s.talkedToWolf ? 1 : 0, s.revealedDestination ? 1 : 0,
        s.forestDelay, s.hummedTune ? 1 : 0, s.warnedWoodcutter ? 1 : 0,
        s.commotionLevel, s.cluesNoticed, JSON.stringify(s.cluesSeen),
        s.wolfSubdued ? 1 : 0, s.grandmotherUntied ? 1 : 0, s.grandmotherWellness,
        JSON.stringify(s.inventory), outcome, s.factionAffinity || "neutral",
        s.loopCount || 0, JSON.stringify(s.memoryFragments), JSON.stringify(s.memoryKeys),
        JSON.stringify(s.endingsSeen), s.rosemaryHeld ? 1 : 0,
        s.ritualReady ? 1 : 0, s.ritualAnswered ? 1 : 0, s.endingId || null,
        s.gameOverTrue ? 1 : 0, s.rescueType || null, s.markDisguised ? 1 : 0,
        s.spectaclesTaken ? 1 : 0,
        s.spectaclesWorn ? 1 : 0,
        s.grandmotherMystic ? 1 : 0, s.standoffChoice || null, s.pactRevealed ? 1 : 0,
        s.deliveryPenaltyApplied ? 1 : 0
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
    new HealingItem("remedies", "Rosemary, pale moss, and bitter roots gathered to treat Grandmother—and ingredients from the forest pact.", 30)
];

const forestEntities = {
    cloak: new GameEntity("cloak", "Your vibrant, hooded red cloak—a cherished gift from your adoring grandmother."),
    squirrels: new ForestDetail("squirrels", "Squirrels scurrying rapidly up the dark, towering oak trees.", true),
    rabbits: new ForestDetail("rabbits", "Rabbits dashing playfully through the shadowy underbrush.", true),
    deer: new ForestDetail("deer", "Deer grazing peacefully in the sun-dappled forest clearings.", true),
    birds: new ForestDetail("birds", "Woodland birds chirping melodiously in the canopy above.", false),
    trees: new ForestDetail("trees", "Tall, ancient trees casting long shadows across the meandering path.", false),
    roots: new ForestDetail("roots", "The roots of the ancient oaks are exposed like knotted fingers. Rosemary grows in a protected hollow; beneath it, faint moon-silver writing circles the heart oak.", false),
    stump: new ForestDetail("stump", "A freshly cut oak stump still dripping sap. Quota marks on its pale face tally the Reeve's demand: the woodcutter is paid by the trunk, and the forest is paying the difference.", false),
    oak: new ForestDetail("oak", "The central oak is older than the village. It carries the silence of a guardian who has seen too many winters.", false),
    moss: new GameEntity("moss", "A patch of moss glows faintly under the roots, as if the forest is trying to leave a trail for you."),
    spectacles: new GameEntity("spectacles", "Grandmother's spectacles, resting awkwardly on a suspiciously large snout. Tiny sigils are etched around the rims."),
    closet: new GameEntity("closet", "A sturdy wooden closet in the corner of the cottage, its frame carved with the same old sigils."),
    raven: new GameEntity("raven", "A one-eyed raven perches above the path. Three pale rings circle its leg, like the annual marks on the heart oak.")
};

const npcs = {
    wolf: new NPC(
        "wolf",
        "A wolf with iron-gray fur and a lean, watchful frame—a displaced guardian of the deep woods rather than a simple monster.",
        '"Where are you bound, child? I guard the heart oak, not the cottage. The logger has marked your cloak; I cannot know whether you carry his intent."'
    ),
    woodcutter: new NPC(
        "woodcutter",
        "A hard-faced logger with a bloodstained axe and the Reeve's quota carved into his ledger; he is stripping the forest faster than it can recover, though refusal would cost him his home.",
        '"The Reeve counts trunks, not lives. I cut because the quota takes my home if I fail it. Don’t mistake a debt for a hunger I chose."'
    ),
    raven: new NPC("raven", "A one-eyed raven that remembers each turning of the day.", "")
};

const worldMap = {
    forest_path: new Location(
        "forest_path",
        "The Deep, Mysterious Forest Path",
        "Tall trees cast long shadows across the well-trodden path. Squirrels scurry up trees, rabbits dash through the underbrush, and deer graze in clearings. A wary wolf guards the heart oak while a logger works beneath it.",
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

const ENDING_REGISTRY = Object.freeze({
    quiet_visit: { title: "The Ordinary Visit", summary: "Red delivers the basket, while the old bargain remains unchosen." },
    transactional_rescue: { title: "The Logger's Due", summary: "The woodcutter saves Red, then names his price." },
    held_line: { title: "The Held Line", summary: "Red holds the line between the guardian and the logger; the wolf remains wary." },
    logger_due: { title: "The Logger's Claim", summary: "Red chooses the logger, and the forest records the cost." },
    grandmother_guarded: { title: "The Ward at the Closet", summary: "Red shields Grandmother behind the old sigils." },
    failed_answer: { title: "The Unanswered Count", summary: "Red knows the marks but cannot answer the forest's question." },
    logger_mark: { title: "The Mark on the Cloak", summary: "The wolf mistakes Red for the logger's agent and carries out his oath to stop her." },
    forest_collapse: { title: "The Forest Unravels", summary: "Six repetitions have weakened the ward beyond repair." },
    warden: { title: "The Warden", summary: "Red keeps the count, protects the heart oak, and accepts the work of tending the pact." },
    unbinding: { title: "The Unbinding", summary: "Red ends the bargain, spending the remedies to release the day from its old promise." }
});
const ENDING_CATALOG = Object.freeze(Object.entries(ENDING_REGISTRY).map(([id, ending]) => Object.freeze({ id, ...ending })));

const recordEnding = (state, endingId, terminal = false) => {
    if (!ENDING_REGISTRY[endingId]) throw new Error(`Unknown ending: ${endingId}`);
    return {
        ...state,
        endingId,
        gameOverTrue: terminal,
        endingsSeen: Object.freeze(state.endingsSeen.includes(endingId)
            ? [...state.endingsSeen]
            : [...state.endingsSeen, endingId])
    };
};

const addMemoryKey = (state, key, fragment) => {
    const next = state.memoryKeys.includes(key)
        ? state
        : { ...state, memoryKeys: Object.freeze([...state.memoryKeys, key]) };
    if (!fragment || next.memoryFragments.includes(fragment)) return next;
    return { ...next, memoryFragments: Object.freeze([...next.memoryFragments, fragment]) };
};

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
    memoryKeys: Object.freeze([...new Set([...(previousState ? previousState.memoryKeys : []), "rosemary"])]),
    endingsSeen: Object.freeze(previousState ? [...previousState.endingsSeen] : []),
    rosemaryHeld: true,
    ritualReady: false,
    ritualAnswered: false,
    endingId: null,
    gameOverTrue: false,
    rescueType: null,
    markDisguised: false,
    endingCatalog: ENDING_CATALOG,
    spectaclesTaken: false,
    spectaclesWorn: false,
    grandmotherMystic: false,
    standoffChoice: null,
    pactRevealed: false,
    deliveryPenaltyApplied: false,
    ...(previousState && previousState.loopCount >= 5
        ? recordEnding({
            endingsSeen: previousState.endingsSeen,
            endingId: null,
            gameOverTrue: false
        }, "forest_collapse", false)
        : {})
});

const applyTransition = (currentState, updaterFn) => Object.freeze(updaterFn({ ...currentState }));

const rememberFragment = (fragment) => (state) => {
    if (!fragment || state.memoryFragments.includes(fragment)) return state;
    return { ...state, memoryFragments: Object.freeze([...state.memoryFragments, fragment]) };
};

const noticeRitualClue = (clue) => (state) => {
    const withClue = noticeClue(clue)(state);
    const withKey = addMemoryKey(withClue, clue);
    const ritualReady = ["eyes", "ears", "teeth"].every(key => withKey.memoryKeys.includes(key));
    return ritualReady && !withKey.ritualReady
        ? { ...withKey, ritualReady: true }
        : withKey;
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
    rescueType: state.warnedWoodcutter ? "preemptive" : "classic",
    inventory: Object.freeze(state.inventory.filter(item => item !== "wine"))
});

const untieGrandmotherFromCloset = (state) => ({
    ...addMemoryKey(state, "grandmother_pact", "Grandmother confirms she bound the day to undo the felling and promised the woodcutter wine if he spared the heart oak."),
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
    (state.wolfSubdued ? 15 : 0) +
    Math.min(15, state.loopCount * 3);

const deliverRemedies = (state, items) => {
    const boost = items
        .filter(item => state.inventory.includes(item.name))
        .reduce((sum, item) => sum + item.wellnessPoints, 0);
    const magicalBoost = state.grandmotherMystic && state.inventory.includes("remedies") ? 10 : 0;
    const spectacleBoost = state.spectaclesTaken && items.some(item => item.name === "remedies") ? 5 : 0;
    return {
        ...state,
        grandmotherWellness: clamp(
            state.grandmotherWellness + boost + magicalBoost + spectacleBoost -
            (state.deliveryPenaltyApplied ? 0 : deliveryPenalty(state)),
            0,
            100
        ),
        deliveryPenaltyApplied: true,
        inventory: Object.freeze(state.inventory.filter(item => !items.some(delivered => delivered.name === item))),
        memoryFragments: state.memoryFragments.includes("The remedies were never ordinary medicine; they were a key to the forest's oldest bargains.")
            ? state.memoryFragments
            : Object.freeze([
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
    standoff_at_cottage :- standoff_choice(none), wolf_seeking_refuge, woodcutter_alerted.

    % The pact is fulfilled when Grandmother is free and healed, and both
    % factions accept its terms. Red must still choose whether to keep or end it.
    fulfilled_pact :- pact_revealed(true), grandmother_mystic(true),
                      grandmother_untied(true), basket_delivered(true),
                      standoff_choice(pact), faction_affinity(forest),
                      wolf_subdued(false).

    preemptive_rescue :- wolf_infiltrated, warned_woodcutter(true), clues_noticed(N), N >= 1.
    classic_rescue    :- wolf_infiltrated, clues_noticed(N), N >= 3, woodcutter_alerted.
    unrescued_ambush  :- wolf_infiltrated, clues_noticed(N), N >= 3,
                         \\+ woodcutter_alerted, faction_affinity(neutral),
                         \\+ mark_disguised(true).
    safe_reunion      :- \\+ wolf_infiltrated.

    story_outcome(true_ending)                 :- game_over_true(true), !.
    story_outcome(pact_fulfilled)              :- fulfilled_pact, !.
    story_outcome(grandmother_saved_and_untied) :- grandmother_untied(true), !.
    story_outcome(standoff)                     :- standoff_at_cottage, !.
    story_outcome(preemptive_woodcutter_rescue) :- preemptive_rescue, !.
    story_outcome(classic_woodcutter_rescue)    :- classic_rescue, !.
    story_outcome(wolf_overwhelms_red)          :- unrescued_ambush, !.
    story_outcome(wolf_waiting_in_disguise)     :- wolf_infiltrated, !.
    story_outcome(peaceful_visit)               :- safe_reunion, !.
    story_outcome(uncertain).
`;

const evaluateChaosRules = (state) => {
    if (state.gameOverTrue) return Promise.resolve("true_ending");
    if (state.endingId === "forest_collapse") return Promise.resolve("forest_collapse");
    return new Promise((resolve, reject) => {
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
            ritual_ready(${state.ritualReady}).
            game_over_true(${state.gameOverTrue}).
            mark_disguised(${state.markDisguised}).
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
};

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
    const loopEcho = state.loopCount === 0
        ? ""
        : `\n\nThe day has turned ${state.loopCount} time${state.loopCount === 1 ? "" : "s"}. Your mother's warning returns in her voice: "Stay on the path. Don't let the logger's mark speak for you."`;
    return `${base}\n\n${describeEnvironmentalLore(state)}${loopEcho}`;
};

const summarizeEnding = (state) => {
    if (state.endingId) {
        const ending = ENDING_REGISTRY[state.endingId];
        return `${state.gameOverTrue ? "TRUE ENDING" : "ENDING"} — ${ending.title}: ${ending.summary}`;
    }
    if (state.standoffChoice === "pact") {
        return "The wolf and woodcutter accept a truce for the wine. Grandmother is free, but the remedies and the old promise still need a deliberate choice before the day can move forward.";
    }
    if (state.standoffChoice === "wolf") {
        return "You choose to oppose the woodcutter beside the wolf, but he never becomes your ally. The disguise and danger remain; only the truth and the woodcutter's arrival can get you to Grandmother.";
    }
    if (state.standoffChoice === "woodcutter") {
        return "You choose the woodcutter, and the forest pays for it with silence. The trees do not forgive a blade that was already raised too early.";
    }
    if (state.standoffChoice === "grandmother") {
        return "You choose to protect grandmother and the fragile boundary between fear and mercy. The forest does not bow, but it lets the day end without a blood sacrifice.";
    }
    if (state.grandmotherUntied && state.factionAffinity === "forest") {
        return "You refuse the logger's quota and listen to the forest. Grandmother is free, but only a keeper's choice can release the day from its pact.";
    }
    if (state.grandmotherUntied && state.factionAffinity === "woodcutter") {
        return "You survive the forest by siding with the logger, but the cost is bitter: the woods fall silent under the axe, and the old pact remains.";
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
    if (state.spectaclesWorn) {
        base.push("The spectacles reveal matching sigils on the cottage walls, closet, and oak roots: Grandmother bound this day in a forest pact.");
    }
    if (state.location === "forest_path") {
        base.push("Near the roots, a trail of pale moss and stripped bark suggests the forest has been leaving clues for someone who knows how to read them.");
        if (state.loopCount >= 2) {
            base.push("The heart oak bears one more pale ring than you remember. The raven's three rings are not years; they count the three witnesses to the pact.");
        }
        if (state.loopCount >= 5) {
            base.push("The outer ward is splitting. Bark flakes drift upward, and even the path seems to forget where it leads.");
        }
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
    const nextState = applyTransition(state, st => recordEnding({
        ...st,
        standoffChoice: choice,
        factionAffinity: choice === "grandmother" ? "neutral" : (choice === "woodcutter" ? "woodcutter" : "forest"),
        warnedWoodcutter: choice === "woodcutter" ? true : st.warnedWoodcutter,
        wolfSubdued: choice === "grandmother" ? true : st.wolfSubdued,
        memoryFragments: Object.freeze([...st.memoryFragments, memoryMap[choice]])
    }, choice === "wolf" ? "held_line" : choice === "woodcutter" ? "logger_due" : "grandmother_guarded"));
    return {
        state: nextState,
        text: choice === "wolf"
            ? "You stand against the woodcutter beside the wolf, hoping to prevent the axe from reaching the forest. The wolf does not trust you or become your ally; his disguise and danger remain. Examine his eyes, ears, and teeth to reveal the threat before the woodcutter can act."
            : choice === "woodcutter"
                    ? "You call the woodcutter in. He offers no heroics: the wolf is a danger, but the rescue comes with his quota and the price of the wine or your silence. The forest recoils; the day's old bargain breaks under steel."
                    : "You press your palm to the closet's carved frame. The sigils flare, holding the disguised wolf at bay long enough for you to open the closet and shield Grandmother. The wolf is contained, not befriended or slain."
    };
};

const GIVE_ITEMS = new Set([...basketItems.map(item => item.name), "basket"]);
const GIVE_RECIPIENTS = new Set(["grandmother", "woodcutter", "wolf"]);
const expandGiveItem = (item) => item === "basket"
    ? basketItems.map(basketItem => basketItem.name)
    : [item];

const pairGiveTargets = (targets) => {
    const groups = [];
    let pendingItems = [];
    for (const target of targets) {
        if (GIVE_ITEMS.has(target)) {
            pendingItems.push(...expandGiveItem(target));
        } else if (GIVE_RECIPIENTS.has(target) && pendingItems.length > 0) {
            const existing = groups.find(group => group.recipient === target);
            if (existing) existing.items.push(...pendingItems);
            else groups.push({ recipient: target, items: [...pendingItems] });
            pendingItems = [];
        }
    }
    if (pendingItems.length > 0) {
        const existing = groups.find(group => group.recipient === "grandmother");
        if (existing) existing.items.push(...pendingItems);
        else groups.push({ recipient: "grandmother", items: [...pendingItems] });
    }
    return groups;
};

const KEEPER_KEYS = Object.freeze(["rosemary", "mother_note", "eyes", "ears", "teeth", "ritual_answer", "pact"]);
const keeperChoiceReady = (state) =>
    state.location === "cottage_interior" &&
    state.grandmotherUntied &&
    state.grandmotherMystic &&
    state.ritualAnswered &&
    state.pactRevealed &&
    state.standoffChoice === "pact" &&
    KEEPER_KEYS.every(key => state.memoryKeys.includes(key));

const keeperChoiceRequirementText = (state) => {
    const missing = KEEPER_KEYS.filter(key => !state.memoryKeys.includes(key));
    if (!state.pactRevealed || state.standoffChoice !== "pact") {
        return "Grandmother's pact is not yet understood or settled. Reveal the wall sigils, then offer the woodcutter his wine at the standoff.";
    }
    if (missing.length) return `The keeper's choice is not ready. The journal still lacks: ${missing.join(", ")}.`;
    if (!state.grandmotherUntied) return "Free Grandmother from the sigil-carved closet so she can explain what the pact promised.";
    if (!state.ritualAnswered) return "Answer the heart oak's count before choosing what becomes of the pact.";
    return "The forest is not ready to accept that choice.";
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
        if (target === "roots") {
            const s = applyTransition(state, st => addMemoryKey(
                st,
                "quota",
                "Under the oak roots, tally marks show the woodcutter's Reeve-imposed quota. His debt is real; so is the ruin it demands."
            ));
            return { state: s, text: `${entity.examine()}\nYou find quota marks beneath the roots. The clue explains the logger's debt without excusing the trees already lost.` };
        }
        if (target === "raven") {
            const remembered = state.loopCount > 0
                ? "The raven croaks, 'Back again. Your mother has left a note for the second turning; read the basket.'"
                : "The raven croaks, 'Ask the bed about eyes, ears, and teeth. When the three agree, answer: The heart oak remembers every ring.'";
            return { text: `${entity.examine()}\n${remembered}` };
        }
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
            if (state.loopCount >= 1 && !state.memoryKeys.includes("mother_note")) {
                const s = applyTransition(state, st => addMemoryKey(
                    st,
                    "mother_note",
                    "On the second turning, a folded note in the basket says: 'If you remember this day, the forest has borrowed it. Rosemary keeps the door; remedies can heal or unbind. Choose only when Grandmother tells you what she promised.'"
                ));
                return {
                    state: s,
                    text: `Under the rosemary sprig, you find your mother's note:\n"If you remember this day, the forest has borrowed it. Rosemary keeps the door; remedies can heal or unbind. Choose only when Grandmother tells you what she promised."\n\n${items.map(i => `• ${i.name.toUpperCase()}: ${i.examine()}`).join("\n")}`
                };
            }
            return {
                text: items.length === 0
                    ? "Your basket is empty; Grandmother has received all her treats and herbal remedies."
                    : `Your basket contains a rosemary sprig and:\n${items.map(i => `• ${i.name.toUpperCase()}: ${i.examine()}`).join("\n")}`
            };
        }
        if (target === "journal") {
            const keys = state.memoryKeys.length ? state.memoryKeys.join(", ") : "none";
            const fragments = state.memoryFragments.length
                ? state.memoryFragments.map(fragment => `• ${fragment}`).join("\n")
                : "No written fragments yet. The day still feels new.";
            return { text: `JOURNAL — Loop ${state.loopCount}\nKnown keys: ${keys}\n${fragments}` };
        }
        if (inCottage && target === "spectacles") {
            return {
                text: state.spectaclesTaken
                    ? "The enchanted spectacles are in your possession. Their rims carry fine sigils matching the marks on the closet frame."
                    : "Grandmother's spectacles rest on the wolf's snout. Fine sigils circle their rims, matching the marks carved into the closet frame. You could take them."
            };
        }
        if (inCottage && target === "walls") {
            if (!state.spectaclesWorn) {
                return { text: "The cottage walls look bare. The spectacles on the bed may reveal what the naked eye cannot." };
            }
            if (state.pactRevealed) {
                return { text: "Through the spectacles, the wall sigils resolve into the pact: Grandmother bound this day so the felling could be undone; the wolf guards the old oaks, and the woodcutter receives wine as his due if he lays down his axe." };
            }
            const s = applyTransition(state, st => ({
                ...addMemoryKey(st, "pact", "The wall sigils reveal Grandmother's pact: undo the felling, protect the old oaks, and give the woodcutter wine if he lays down his axe."),
                pactRevealed: true
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
            const s = applyTransition(state, noticeRitualClue(target));
            let text = CLUE_TEXT[target];
            if (s.cluesNoticed >= 3) {
                text += s.markDisguised
                    ? "\nThe disguise falls away—the wolf is in the bed, and Grandmother is in the sigil-marked closet. The silver moss hides the logger's chalk; the wolf hesitates, but remains dangerous."
                    : "\nThe disguise falls away—the wolf is in the bed, and Grandmother is bound in the sigil-marked closet.";
                text += "\nThe three clues form an answer: 'The heart oak remembers every ring.' Say it aloud to answer the forest.";
            } else if (s.ritualReady) {
                text += "\nThe three clues form an answer: 'The heart oak remembers every ring.' Say it aloud to answer the forest.";
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
        if (target === "roots" && state.location === "forest_path") {
            const s = applyTransition(state, st => addMemoryKey(
                st,
                "quota",
                "Under the oak roots, tally marks show the woodcutter's Reeve-imposed quota. His debt is real; so is the ruin it demands."
            ));
            return { state: s, text: `${forestEntities.roots.examine()}\nThe quota marks reveal the Reeve's debt. His fear is understandable; his felling still wounds the forest.` };
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
                state: applyTransition(state, st => addMemoryKey(
                    speakToStranger(st), "wolf_guardian", "The wolf is a guardian of the heart oak, but he suspects Red carries the logger's mark."
                )),
                text: `${state.loopCount ? '"You came back. I remember the red mark."' : npcs.wolf.speak()}\nYou tell him where you are going despite your mother's warning. The wolf watches your cloak; sworn to stop the logger's agents, he cannot tell whether you are one.`
            };
        }
        if (target === "woodcutter") {
            return {
                state: applyTransition(state, st => addMemoryKey(
                    alertWoodcutter(st), "quota", "The woodcutter works under the Reeve's quota. His debt is real, but the heart oak is still being cut."
                )),
                text: `${state.loopCount ? '"You again. The Reeve still wants the same number of trunks."' : npcs.woodcutter.speak()}\nHe will watch the cottage, but warns that the Reeve's quota follows him even here.`
            };
        }
        if (target === "raven") {
            return {
                state: applyTransition(state, st => rememberFragment(`The raven remembers the turnings and counts three witnesses to the forest pact.`)(st)),
                text: state.loopCount > 0
                    ? "The raven tilts its head. 'Back again. Your mother left a note beneath the rosemary. Read it before you choose what to do with the remedies.'"
                    : "The raven croaks, 'Three witnesses: eyes, ears, teeth. Answer the heart oak, and the day may hear you. The answer is: The heart oak remembers every ring.'"
            };
        }
        return { text: "Specify who you want to talk to: 'talk to wolf' or 'talk to woodcutter'." };
    },

    answer: ({ state, command }) => {
        if (state.location !== "cottage_interior") return { text: "The forest's question can only be answered at the cottage threshold." };
        if (!state.ritualReady) return { text: "The answer has no force yet. Learn what the eyes, ears, and teeth conceal first." };
        const normalized = command.toLowerCase().replace(/[^a-z\s]/g, " ").replace(/\s+/g, " ").trim();
        const correct = /heart oak remembers every ring|heart oak remember the? rings?/.test(normalized);
        if (!correct) {
            const s = applyTransition(state, st => recordEnding(addMemoryKey(
                { ...st, ritualAnswered: false },
                "failed_answer",
                "Red gave an answer the forest did not recognize; the count remains unfinished."
            ), "failed_answer"));
            return {
                state: s,
                text: "The sigils flare, then go dark. 'That is not the count,' Grandmother whispers from the closet. The wolf mistakes your hesitation for the logger's signal; you may still learn the true answer, but the ward is weaker."
            };
        }
        const s = applyTransition(state, st => ({
            ...addMemoryKey(st, "ritual_answer", "The heart oak remembers every ring. The forest accepts the answer, though the wolf still does not trust Red."),
            ritualAnswered: true,
            wolfSubdued: true
        }));
        return {
            state: s,
            text: "You answer, 'The heart oak remembers every ring.' The sigils catch the words and hold the wolf at bay—not as an ally, but as a guardian bound by the forest's recognition. The closet is within reach; Grandmother must explain the pact herself."
        };
    },

    keep: ({ state }) => {
        if (!keeperChoiceReady(state)) return { text: keeperChoiceRequirementText(state) };
        const s = applyTransition(state, st => recordEnding({
            ...st,
            grandmotherWellness: 100
        }, "warden", true));
        return {
            state: s,
            text: "You keep the count: the heart oak, the wolf's charge, the logger's due, and Grandmother's promise. You choose to tend the pact rather than inherit its punishment. The remedies remain in your basket; the loop breaks, and the woods begin to heal.\n\nTRUE ENDING — THE WARDEN."
        };
    },

    end: ({ state }) => {
        if (!keeperChoiceReady(state)) return { text: keeperChoiceRequirementText(state) };
        if (!state.inventory.includes("remedies")) {
            return { text: "The remedies are no longer yours to spend. The Unbinding requires that you keep them until Grandmother can choose with you." };
        }
        const s = applyTransition(state, st => recordEnding({
            ...st,
            inventory: Object.freeze(st.inventory.filter(item => item !== "remedies")),
            grandmotherWellness: clamp(st.grandmotherWellness + 10, 0, 100)
        }, "unbinding", true));
        return {
            state: s,
            text: "You give the remedies to Grandmother, who uses their last warmth to unbind the forest from its promise. The woodcutter's quota remains unjust, the wolf's watch is his own, and the day is no longer held hostage by any of them.\n\nTRUE ENDING — THE UNBINDING."
        };
    },

    read: ({ state, target }) => target === "journal"
        ? handlers.examine({ state, target: "journal" })
        : target === "basket"
            ? handlers.examine({ state, target: "basket" })
            : { text: "There is nothing legible here. Try 'read journal' to revisit what the loops have taught you." },

    wander: ({ state }) => {
        if (state.location !== "forest_path") {
            return { text: "There is nowhere to wander off to from here." };
        }
        const s = applyTransition(state, st => addMemoryKey({
            ...lingerInWoods(st),
            markDisguised: true
        },
            "quota",
            "The logger's chalk hides tally marks for the Reeve's quota. Knowing his debt gives Red leverage, but each step off the path weakens the ward."
        ));
        return {
            state: s,
            text: `Ignoring your mother's stern advice, you find quota marks beneath a fresh-cut oak: the Reeve's tally explains why the logger keeps cutting. You smear silver moss over the chalk on your cloak, hiding the logger's mark from the wolf. The detour weakens the ward (Forest Delay: ${s.forestDelay}).`
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
                const forestAlliance = state.standoffChoice === "pact";
                return {
                    state: applyTransition(state, untieGrandmotherFromCloset),
                    text: forestAlliance
                        ? "The wolf watches warily as you name the pact; he does not trust you, but the terms hold him at the threshold. You open the sigil-carved closet and free the real Grandmother, an exiled witch whose wrists bear the forest's old runes. She confirms she bound the day to undo the felling. Keep the remedies until you decide whether to heal her or end the bargain."
                        : "The old sigils hold the disguised wolf at bay as you open the closet and free Grandmother. She is an exiled witch whose wrists bear the forest pact. Keep the remedies until you decide whether to heal her or end the bargain."
                };
            }
            return { text: "You cannot reach the closet while the figure in the bed watches your every move!" };
        }
        return { text: "Specify what you want to open (e.g., 'open closet')." };
    },

    give: ({ state, target, priorOutcome, itemsToGive }) => {
        if (state.location !== "cottage_interior") return { text: "You must be inside Grandmother's cottage to deliver the basket." };
        const requestedItems = itemsToGive || (target === "basket"
            ? basketItems.map(item => item.name)
            : (basketItems.some(item => item.name === target) ? [target] : []));
        if (target === "wolf") return { text: "You would never hand your mother's treats to a stranger with teeth like that." };
        if (target === "woodcutter") {
            if (!requestedItems.includes("wine")) {
                return { text: "The woodcutter refuses the offer. The forest pact names the wine as his due; the bread, cakes, and remedies are for Grandmother." };
            }
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
        const requested = requestedItems.length > 0 ? requestedItems : basketItems.map(item => item.name);
        const remainingBasketItems = basketItems.filter(item =>
            requested.includes(item.name) && state.inventory.includes(item.name));
        if (remainingBasketItems.length === 0) return { text: "You have none of those items left to give." };
        if (target !== "grandmother" && requestedItems.length === 0 && target !== "basket") {
            return { text: "Specify what to give and to whom (for example, 'give bread to grandmother')." };
        }
        if (priorOutcome === "peaceful_visit" || state.grandmotherUntied) {
            let s = applyTransition(state, st => deliverRemedies(st, remainingBasketItems));
            const deliveryComplete = basketItems.every(item => !s.inventory.includes(item.name));
            if (deliveryComplete && !s.endingId) {
                s = applyTransition(s, st => recordEnding(
                    st,
                    st.rescueType ? "transactional_rescue" : "quiet_visit"
                ));
            }
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

    take: ({ state, target }) => {
        if (state.location !== "cottage_interior" || target !== "spectacles") {
            return { text: "There is nothing here to take by hand." };
        }
        if (state.spectaclesTaken) return { text: "You already have Grandmother's spectacles." };
        const s = applyTransition(state, st => ({
            ...st,
            spectaclesTaken: true,
            inventory: Object.freeze([...st.inventory, "spectacles"])
        }));
        return { state: s, text: "You carefully lift the enchanted spectacles from the wolf's snout. Their rims bear the cottage's sigils. They are yours to wear when you are ready." };
    },

    wear: ({ state, target }) => {
        if (target !== "spectacles") return { text: "You can only wear the enchanted spectacles." };
        if (!state.spectaclesTaken) return { text: "The spectacles are not in your possession yet." };
        if (state.spectaclesWorn) return { text: "The enchanted spectacles are already on your face; the hidden sigils remain visible." };
        const s = applyTransition(state, st => ({
            ...st,
            spectaclesWorn: true,
            memoryFragments: Object.freeze([...st.memoryFragments, "Wearing the spectacles reveals hidden truths in the world as though it were writing in moonlight."])
        }));
        return {
            state: s,
            text: "You set the enchanted spectacles on your face. The world sharpens into pale glyphs and hidden paths; the cottage seems less like a home and more like a riddle the forest has been trying to solve for years."
        };
    },

    help: () => ({
        text: [
            "Available Commands:",
            "• Sensory & Exploration: 'look around', 'listen', 'smell', 'hum tune', 'examine basket', 'examine cloak'",
            "• Forest Interactions: 'watch squirrels/rabbits/deer', 'watch roots', 'watch oak', 'talk to woodcutter', 'talk to wolf', 'wander off path'",
            "• Movement: 'walk to cottage', 'go back'",
            "• Cottage Progression: 'lift latch', 'examine spectacles', 'take spectacles', 'wear spectacles', 'examine walls', 'examine eyes/ears/teeth', 'answer the heart oak remembers every ring'",
            "• Standoff Choices: 'choose wolf', 'choose woodcutter', 'protect grandmother', or uncover the pact and 'give wine to woodcutter'",
            "• Resolution: 'open closet', 'untie grandmother', 'give bread to grandmother'",
            "• Multi-item Giving: 'give wine to woodcutter and bread to grandmother'",
            "• Lore: 'talk to raven', 'examine journal', 'read basket'",
            "• True endings: 'keep the count' (Warden) or 'end the bargain' (Unbinding)"
        ].join("\n")
    })
};

const runCommand = async (userId, command) => {
    let state = (await getPlayerStateFromDB(userId)) || createInitialState();
    if (state.gameOverTrue || state.endingId === "forest_collapse") {
        return {
            response: state.endingId === "forest_collapse"
                ? "The forest has unraveled. The day cannot turn again."
                : `The loop is closed. ${ENDING_REGISTRY[state.endingId]?.title || "This ending"} is final; the day does not repeat.`,
            chaosOutcome: await evaluateChaosRules(state),
            state,
            mlTelemetry: { subwords: [], tokenIds: [], corrections: [], resolvedIntent: "TIMELINE CLOSED" }
        };
    }

    // --- ML layer: BPE tokenize (+typo snapping) -> Prolog intent ---
    const enc = encodeCommand(command);
    const { verb, target, targets = [target] } = await resolveIntentWithProlog(enc.words);
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

    if (resolved && verb === "give") {
        const giveGroups = pairGiveTargets(targets);
        if (giveGroups.length > 0) {
            const responses = [];
            for (const group of giveGroups) {
                const result = handlers.give({
                    state,
                    target: group.recipient,
                    priorOutcome,
                    itemsToGive: group.items
                });
                if (result.state) state = result.state;
                responses.push(result.text);
            }
            narrativeResponse = responses.join("\n");
        } else {
            const result = handlers.give({ state, target, priorOutcome, command });
            if (result.state) state = result.state;
            narrativeResponse = result.text;
        }
    } else {
        // "back" is a target in the lexicon, so "go back" / "return" work with any verb.
        const key = target === "back" ? "back" : verb;
        const handler = handlers[key];

        if (resolved && handler) {
            const result = await handler({ state, target, priorOutcome, command });
            narrativeResponse = result.text;
            if (result.state) state = result.state;
        }
    }

    // Re-evaluate Prolog after the command's state transition
    const chaosOutcome = await evaluateChaosRules(state);
    if (chaosOutcome === "wolf_overwhelms_red" && !state.endingId) {
        state = applyTransition(state, st => recordEnding(st, "logger_mark"));
    }

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

const WELCOME_TEXT = "Welcome to LITTLE RED RIDING HOOD: CHAOS IN THE DEEP WOODS.\nYour mother hands you bread, sweet wine, cakes, herbal remedies, and a sprig of rosemary for Grandmother.\n\"Stay on the path, Red. The logger's mark is not your own,\" she warns; you cannot tell why the words feel familiar.\nSomewhere in the cottage, an old pact is keeping the day from moving forward. Type 'help' for commands, or 'look around' to begin.";

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
                ? saved.gameOverTrue || saved.endingId === "forest_collapse"
                    ? "This timeline has reached its ending. The day does not repeat."
                    : `Resumed saved timeline for '${userId}'. Type 'look around' to get your bearings, or press Reset Timeline to start over.`
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
        if (previousState && (previousState.gameOverTrue || previousState.endingId === "forest_collapse")) {
            return res.status(409).json({ error: "The loop is closed. This ending is final; the day does not repeat." });
        }
        const initialState = createInitialState(previousState || createInitialState());
        const outcome = await evaluateChaosRules(initialState);
        await withUserLock(userId, () => savePlayerStateToDB(userId, initialState, outcome));
        const rememberText = initialState.endingId === "forest_collapse"
            ? "The outer ward gives way. The heart oak is falling in every remembered version of the day; there is no next loop."
            : previousState && previousState.memoryFragments.length
                ? `You carry the memory of the previous loop: ${previousState.memoryFragments[previousState.memoryFragments.length - 1]}`
                : "Grandmother's old pact has bound the day in a loop: the felling must be undone, the forest protected, and the woodcutter's due fairly paid.";
        const motherText = initialState.endingId === "forest_collapse"
            ? "Mother's warning is swallowed by the breaking woods."
            : initialState.loopCount >= 2
                ? "Mother hands you the basket. Her warning now carries an echo: 'Read what I tucked beneath the rosemary. Don't spend the remedies before you know what they can do.'"
                : initialState.loopCount === 1
                    ? "Mother hands you the basket again. 'You look as though you have heard this before. Stay on the path, Red.'"
                    : "Mother hands you the basket: 'Stay on the path and avoid talking to strangers!'";
        res.json({
            response: initialState.endingId === "forest_collapse"
                ? `Timeline reset. ${rememberText}`
                : `Timeline reset. The path opens again, but it does not feel new. ${rememberText}\n${motherText} Type 'help' for commands.`,
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
