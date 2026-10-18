const pl = require('tau-prolog');

// ============================================================================
// WHAT THIS MODULE IS
// A BPE tokenizer whose merges are learned from the game's own lexicon, plus
// edit-distance snapping so near-miss typos ("wolff", "exmaine") land on a
// known word, plus a Prolog intent resolver. It is't a neural model and it
// doesn't generalize beyond the lexicon + small typos. 
// ============================================================================

// ============================================================================
// SHARED DATA: single source of truth for the tokenizer corpus, the Prolog
// rules, AND the server's command dispatch (server.js imports LEXICON keys).
// ============================================================================
const STOP_WORDS = new Set([
    "the", "a", "an", "to", "at", "in", "on", "with", "into", "from",
    "off", "up", "for", "my", "her", "his", "of", "and"
]);

const LEXICON = Object.freeze({
    verbs: {
        examine: ['look', 'looking', 'examine', 'examining', 'inspect', 'inspecting', 'check', 'checking', 'peek', 'see', 'stare'],
        talk:    ['talk', 'talking', 'speak', 'speaking', 'chat', 'ask', 'greet', 'tell', 'warn', 'warning'],
        watch:   ['watch', 'watching', 'follow', 'following', 'chase', 'chasing', 'admire', 'pet', 'observe'],
        wander:  ['wander', 'wandering', 'stray', 'leave', 'roam', 'explore'],
        walk:    ['walk', 'walking', 'go', 'going', 'travel', 'proceed', 'continue', 'run', 'head'],
        open:    ['open', 'opening', 'lift', 'lifting', 'knock', 'knocking', 'unlock', 'untie', 'free', 'enter'],
        give:    ['give', 'giving', 'deliver', 'hand', 'share', 'heal', 'feed', 'offer', 'use'],
        wear:    ['wear', 'wearing', 'put', 'putting', 'don', 'donning'],
        take:    ['take', 'taking', 'steal', 'stealing', 'grab', 'grabbing'],
        hum:     ['hum', 'humming', 'sing', 'singing', 'whistle', 'melody', 'tune'],
        listen:  ['listen', 'listening', 'hear', 'hearing', 'sound'],
        smell:   ['smell', 'smelling', 'sniff', 'sniffing', 'scent', 'aroma'],
        read:    ['read', 'reading', 'decipher', 'decode', 'translate'],
        answer:  ['answer', 'respond', 'reply'],
        accuse:  ['accuse', 'accusing', 'blame', 'charge'],
        diagnose:['diagnose', 'diagnosing', 'identify', 'trace'],
        track:   ['track', 'tracking', 'trail', 'trace'],
        contain: ['contain', 'containing', 'quarantine', 'isolate', 'block'],
        guard:   ['guard', 'guarding', 'defend', 'defending', 'protect', 'protecting'],
        approach:['approach', 'approaching', 'meet'],
        keep:    ['keep', 'keeping', 'hold', 'holding', 'preserve'],
        end:     ['end', 'ending', 'break', 'unbind', 'release'],
        remember:['remember', 'recall'],
        cast:    ['cast', 'casting', 'channel'],
        banish:  ['banish', 'banishing', 'expel', 'repel', 'dispel'],
        help:    ['help', 'command', 'commands', 'hint']
    },
    targets: {
        wolf:        ['wolf', 'stranger', 'predator', 'beast'],
        woodcutter:  ['woodcutter', 'lumberjack', 'woodsman', 'axe'],
        basket:      ['basket', 'inventory', 'treat', 'treats', 'goodies'],
        bread:       ['bread'],
        wine:        ['wine'],
        cakes:       ['cake', 'cakes'],
        remedies:    ['remedy', 'remedies', 'medicine', 'herbs'],
        cloak:       ['cloak', 'hood', 'cape'],
        squirrels:   ['squirrel', 'squirrels'],
        rabbits:     ['rabbit', 'rabbits', 'bunny'],
        deer:        ['deer', 'fawn', 'creatures', 'animals'],
        birds:       ['bird', 'birds'],
        trees:       ['tree', 'trees', 'pine'],
        roots:       ['root', 'roots', 'moss'],
        stump:       ['stump', 'stumps'],
        brook:       ['brook', 'stream', 'creek', 'water'],
        hamlet:      ['hamlet', 'village', 'villagers'],
        woodland:    ['woodland', 'wildlife', 'forestfolk'],
        logging_camp:['camp', 'loggingcamp', 'loggercamp', 'loggers'],
        outbreak:    ['outbreak', 'illness', 'sickness', 'disease'],
        red:         ['red', 'girl', 'rider'],
        forest:      ['forestfolk', 'heartoak'],
        water_supply:['watersupply', 'well'],
        spores:      ['spore', 'spores', 'blight'],
        rosemary:    ['rosemary'],
        raven:       ['raven', 'crow'],
        journal:     ['journal', 'memories', 'memory'],
        note:        ['note', 'letter'],
        heart:       ['heart'],
        ring:        ['ring', 'rings'],
        count:       ['count', 'quota'],
        bargain:     ['bargain', 'pact'],
        mother:      ['mother'],
        oak:         ['oak'],
        spectacles:  ['spectacle', 'spectacles', 'glasses', 'snout'],
        eyes:        ['eye', 'eyes'],
        ears:        ['ear', 'ears'],
        teeth:       ['teeth', 'tooth', 'fang', 'fangs'],
        figure:      ['figure', 'bed', 'disguise', 'nightgown'],
        latch:       ['latch', 'door', 'front'],
        closet:      ['closet'],
        walls:       ['wall', 'walls', 'plaster', 'paneling'],
        grandmother: ['grandmother', 'grandma', 'granny'],
        cottage:     ['cottage', 'house', 'home'],
        back:        ['back', 'return', 'retreat', 'backward', 'backwards'],
        path:        ['path', 'road', 'trail', 'woods', 'forest', 'around', 'room'],
        sigils:      ['sigil', 'sigils', 'glyph', 'glyphs', 'rune', 'runes']
    }
});

// Target categories for multi-target give pairing (item → recipient).
const ITEM_TARGETS = Object.freeze(new Set([
    'bread', 'wine', 'cakes', 'remedies', 'rosemary', 'basket', 'spectacles', 'cloak'
]));
const CHARACTER_TARGETS = Object.freeze(new Set([
    'wolf', 'woodcutter', 'grandmother', 'figure', 'hamlet', 'woodland', 'logging_camp'
]));

const LEXICON_WORDS = Object.freeze([
    ...Object.values(LEXICON.verbs).flat(),
    ...Object.values(LEXICON.targets).flat()
]);
const LEXICON_SET = new Set(LEXICON_WORDS);

// ============================================================================
// 1. FUNCTIONAL PARADIGM: Pure Text Normalization and Pair Reducers
// ============================================================================
const normalizeText = (text) =>
    String(text).toLowerCase().replace(/[^a-z0-9\s]/g, "").trim();

const splitWords = (text) =>
    Object.freeze(normalizeText(text).split(/\s+/).filter(w => w && !STOP_WORDS.has(w)));

const toWordChars = (word) => Object.freeze([...word.split(""), "</w>"]);

const getPairFrequencies = (tokenizedWords) =>
    tokenizedWords.reduce((freqMap, wordTokens) => {
        for (let i = 0; i < wordTokens.length - 1; i++) {
            const pairKey = `${wordTokens[i]} ${wordTokens[i + 1]}`;
            freqMap[pairKey] = (freqMap[pairKey] || 0) + 1;
        }
        return freqMap;
    }, Object.create(null));

const levenshtein = (a, b) => {
    const prev = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
        let diag = prev[0];
        prev[0] = i;
        for (let j = 1; j <= b.length; j++) {
            const tmp = prev[j];
            prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
            diag = tmp;
        }
    }
    return prev[b.length];
};

// Short words must match exactly ("what" must never snap to "chat").
const maxEdits = (len) => (len <= 4 ? 0 : len <= 6 ? 1 : 2);

// Returns the unique closest lexicon word within the edit budget, else null.
const snapToLexicon = (raw) => {
    const budget = maxEdits(raw.length);
    if (budget === 0) return null;
    let best = null, bestDist = Infinity, tie = false;
    for (const w of LEXICON_SET) {
        if (Math.abs(w.length - raw.length) > budget) continue;
        const d = levenshtein(raw, w);
        if (d < bestDist) { best = w; bestDist = d; tie = false; }
        else if (d === bestDist) tie = true;
    }
    return bestDist <= budget && !tie ? best : null;
};

// ============================================================================
// 2. OBJECT-ORIENTED PARADIGM: Tokenizer Class Hierarchy and Inheritance
// ============================================================================
class BaseTokenizer {
    constructor(specialTokens = ["<PAD>", "<UNK>"]) {
        this.vocab = Object.create(null);
        this.inverseVocab = Object.create(null);
        specialTokens.forEach((token, idx) => this._registerToken(token, idx));
    }

    _registerToken(token, id) {
        this.vocab[token] = id;
        this.inverseVocab[id] = token;
    }

    encode(text) {
        throw new Error("encode() must be implemented by subclass");
    }
}

class BPETokenizer extends BaseTokenizer {
    constructor(vocabSize = 2000) {
        super(["<PAD>", "<UNK>", "</w>"]);
        this.vocabSize = vocabSize;
        this.merges = [];
    }

    _applyMerge(word, first, second) {
        const merged = first + second;
        let j = 0;
        while (j < word.length - 1) {
            if (word[j] === first && word[j + 1] === second) word.splice(j, 2, merged);
            else j++;
        }
    }

    // ========================================================================
    // 3. IMPERATIVE PARADIGM: Iterative BPE Merge Loop and State Mutation
    // ========================================================================
    train(corpusText) {
        const words = splitWords(corpusText).map(w => [...toWordChars(w)]);
        let nextId = Object.keys(this.vocab).length;

        for (const word of words) {
            for (const char of word) {
                if (this.vocab[char] === undefined) this._registerToken(char, nextId++);
            }
        }

        while (nextId < this.vocabSize) {
            const pairCounts = getPairFrequencies(words);
            let bestPair = null;
            let maxCount = 0;
            for (const [pair, count] of Object.entries(pairCounts)) {
                if (count > maxCount) {
                    maxCount = count;
                    bestPair = pair;
                }
            }
            if (!bestPair || maxCount < 2) break;

            const [first, second] = bestPair.split(" ");
            this.merges.push([first, second]);
            this._registerToken(first + second, nextId++);
            for (const word of words) this._applyMerge(word, first, second);
        }
    }

    encode(text) {
        const rawWords = splitWords(text);
        const words = rawWords.map(w => [...toWordChars(w)]);
        for (const [first, second] of this.merges) {
            for (const word of words) this._applyMerge(word, first, second);
        }

        const flat = words.flat();
        // Subwords keep "</w>" visible so subwords[i] always lines up with tokenIds[i].
        const subwords = flat;
        const tokenIds = flat.map(t => this.vocab[t] ?? this.vocab["<UNK>"]);

        return Object.freeze({
            rawWords: Object.freeze(rawWords),
            words: Object.freeze(words.map(w => Object.freeze([...w]))),
            subwords: Object.freeze(subwords),
            tokenIds: Object.freeze(tokenIds)
        });
    }
}

// ============================================================================
// Training. Words are joined with spaces BOTH inside a repetition and between
// repetitions (the old `.repeat(6)` glued "room"+"look" into "roomlook").
// ============================================================================
const storyCorpus = Array(6).fill(LEXICON_WORDS.join(" ")).join(" ");

const gameTokenizer = new BPETokenizer(2000);
gameTokenizer.train(storyCorpus);

const isSingleWordToken = (tokens) => tokens.length === 1 && tokens[0].endsWith("</w>");

// Fail loudly at startup if any lexicon word is not a single token, instead
// of silently dropping it from intent resolution.
{
    const broken = LEXICON_WORDS.filter(w => !isSingleWordToken(gameTokenizer.encode(w).words[0]));
    if (broken.length) {
        throw new Error(`BPE vocabulary too small / training broken; not single tokens: ${broken.join(", ")}`);
    }
}

// Tokenize, then snap near-miss typos onto lexicon words.
// `words` feeds Prolog; `subwords`/`tokenIds` are the honest BPE view of the raw input.
const encodeCommand = (text) => {
    const enc = gameTokenizer.encode(text);
    const corrections = [];
    const words = enc.words.map((tokens, i) => {
        if (isSingleWordToken(tokens)) return tokens;
        const fix = snapToLexicon(enc.rawWords[i]);
        if (!fix) return tokens;
        corrections.push({ from: enc.rawWords[i], to: fix });
        return Object.freeze([`${fix}</w>`]);
    });
    return Object.freeze({
        ...enc,
        words: Object.freeze(words),
        corrections: Object.freeze(corrections)
    });
};

// ============================================================================
// 4. LOGIC PARADIGM: Prolog Intent Resolution (order-aware, multi-target)
// ============================================================================
const toPrologList = (ws) => `[${ws.map(w => `'${w}'`).join(",")}]`;

const lexiconFacts = [
    ...Object.entries(LEXICON.verbs).map(([v, ws]) => `verb_words(${v}, ${toPrologList(ws)}).`),
    ...Object.entries(LEXICON.targets).map(([t, ws]) => `target_words(${t}, ${toPrologList(ws)}).`)
].join("\n");

const INTENT_RULES = `
    :- dynamic(word/2).

    mem(X, [X|_]).
    mem(X, [_|T]) :- mem(X, T).

    verb_at(P, V)   :- word(P, X), verb_words(V, L), mem(X, L).
    target_at(P, T) :- word(P, X), target_words(T, L), mem(X, L).

    % Earliest verb in the sentence wins
    first_verb(P) :- verb_at(P, _), \\+ (verb_at(Q, _), Q < P).

    % Earliest target that is not the same word as the verb (before OR after it)
    first_target(VP, T) :- target_at(P, T), P =\\= VP,
                           \\+ (target_at(Q, _), Q =\\= VP, Q < P).

    % Collect ALL targets in position order (excluding the verb position).
    % Used for multi-target commands like "give wine to woodcutter and bread to grandmother".
    all_targets(VP, Ts) :- findall(T, (target_at(P, T), P =\\= VP), Ts).

    parsed_intent(V, Ts) :- first_verb(VP), verb_at(VP, V), !,
                             all_targets(VP, Ts0),
                             (Ts0 = [] -> Ts = [around] ; Ts = Ts0).
    parsed_intent(examine, [T]) :- first_target(0, T), !.
    parsed_intent(unknown, [none]).
`;

// Convert a tau-prolog list term to a JavaScript array of atom ids.
const prologListToArray = (term) => {
    const result = [];
    let current = term;
    while (current && current.id === '.' && current.args && current.args.length === 2) {
        result.push(current.args[0].id);
        current = current.args[1];
    }
    return result;
};

const resolveIntentWithProlog = (encodedWords) => {
    return new Promise((resolve, reject) => {
        const session = pl.create();

        // Only fully-learned words (a single "word</w>" token) become facts
        const wordFacts = encodedWords
            .map((tokens, i) =>
                isSingleWordToken(tokens)
                    ? `word(${i + 1}, '${tokens[0].replace("</w>", "")}').`
                    : null)
            .filter(Boolean)
            .join("\n");

        session.consult(`${INTENT_RULES}\n${lexiconFacts}\n${wordFacts}\n`, {
            success: () => {
                session.query("parsed_intent(Verb, Targets).", {
                    success: () => {
                        session.answer(answer => {
                            if (pl.type.is_error(answer)) {
                                reject(new Error(pl.format_answer(answer)));
                            } else if (pl.type.is_substitution(answer)) {
                                const targets = prologListToArray(answer.lookup("Targets"));
                                resolve({
                                    verb: answer.lookup("Verb").id,
                                    target: targets[0] || 'around',
                                    targets: targets
                                });
                            } else {
                                resolve({ verb: "unknown", target: "none", targets: ["none"] });
                            }
                        });
                    },
                    error: reject
                });
            },
            error: reject
        });
    });
};

module.exports = {
    gameTokenizer,
    encodeCommand,
    resolveIntentWithProlog,
    snapToLexicon,
    STOP_WORDS,
    LEXICON,
    ITEM_TARGETS,
    CHARACTER_TARGETS
};