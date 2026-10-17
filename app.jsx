import { useState, useEffect, useRef } from 'react';

// Use the same host the page was served from, so demo-ing from another machine works.
// Override with window.__API__ if the server lives elsewhere.
const API =
  (typeof window !== 'undefined' && window.__API__) ||
  `${window.location.protocol}//${window.location.hostname}:3000`;

const INITIAL_WELLNESS = 35;
const EMPTY_TELEMETRY = { subwords: [], tokenIds: [], corrections: [], resolvedIntent: 'AWAITING INPUT' };

const post = async (path, body) => {
  const res = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Server error');
  return data;
};

export default function App() {
  const [userId, setUserId] = useState('red_player_1');
  const [input, setInput] = useState('');
  const [logs, setLogs] = useState([{ sender: 'SYSTEM', text: 'Loading your timeline...' }]);
  const [gameState, setGameState] = useState(null);
  const [chaosOutcome, setChaosOutcome] = useState('peaceful_visit');
  const [mlTelemetry, setMlTelemetry] = useState(EMPTY_TELEMETRY);
  // One request at a time: stops double-submits and out-of-order responses.
  const [busy, setBusy] = useState(false);
  const terminalEndRef = useRef(null);
  const inputRef = useRef(null);
  const loadedIdRef = useRef(null); // account whose state is currently shown

  useEffect(() => {
    terminalEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  const applyServerState = (data) => {
    setGameState(data.state);
    setChaosOutcome(data.chaosOutcome);
  };

  // Resume the saved timeline (or show the welcome text for a new account).
  // Also runs when the Account ID is committed, so the sidebar never shows another player's data.
  const loadPlayer = async (id = userId) => {
    loadedIdRef.current = id;
    setBusy(true);
    try {
      const res = await fetch(`${API}/api/state?userId=${encodeURIComponent(id)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Server error');
      setLogs([{ sender: 'SYSTEM', text: data.response }]);
      applyServerState(data);
      setMlTelemetry(EMPTY_TELEMETRY);
    } catch (err) {
      setLogs([{ sender: 'ERROR', text: `Could not reach the game server at ${API}: ${err.message}` }]);
    } finally {
      setBusy(false);
      inputRef.current?.focus();
    }
  };

  useEffect(() => {
    loadPlayer();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const sendCommand = async (e) => {
    e.preventDefault();
    if (busy || !input.trim()) return;

    const userCommand = input;
    setInput('');
    setBusy(true);
    setLogs((prev) => [...prev, { sender: 'PLAYER', text: `> ${userCommand}` }]);

    try {
      const data = await post('/api/command', { userId, command: userCommand });
      setLogs((prev) => [...prev, { sender: 'GAME', text: data.response }]);
      applyServerState(data);
      if (data.mlTelemetry) setMlTelemetry(data.mlTelemetry);
    } catch (err) {
      setLogs((prev) => [...prev, { sender: 'ERROR', text: `Failed: ${err.message}` }]);
    } finally {
      setBusy(false);
      inputRef.current?.focus();
    }
  };

  const resetTimeline = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const data = await post('/api/reset', { userId });
      setLogs([{ sender: 'SYSTEM', text: data.response }]);
      applyServerState(data);
      setMlTelemetry(EMPTY_TELEMETRY);
    } catch (err) {
      setLogs((prev) => [...prev, { sender: 'ERROR', text: `Reset failed: ${err.message}` }]);
    } finally {
      setBusy(false);
      inputRef.current?.focus();
    }
  };

  const gs = gameState;
  const chapterSummary = (() => {
    if (!gs) return null;
    const { chaosOutcome, factionAffinity, grandmotherUntied, grandmotherWellness, wolfSubdued } = gs;
    if (chaosOutcome === 'peaceful_visit') {
      return 'CHAPTER SUMMARY — The forest holds. You preserve the path, keep the bargain of the woods, and leave the cottage in a state of uneasy calm.';
    }
    if (chaosOutcome === 'preemptive_woodcutter_rescue' || chaosOutcome === 'classic_woodcutter_rescue' || grandmotherUntied) {
      return `CHAPTER SUMMARY — The cottage is no longer a lie. ${factionAffinity === 'forest' ? 'You stood with the forest.' : factionAffinity === 'woodcutter' ? 'You stood with the ragged edge of survival.' : 'You chose the hard path between both.'} Wellness: ${grandmotherWellness}%.`;
    }
    if (chaosOutcome === 'wolf_overwhelms_red') {
      return 'CHAPTER SUMMARY — The loop closes. The forest remembers your failure, and the path opens again for another attempt.';
    }
    if (wolfSubdued) {
      return 'CHAPTER SUMMARY — The wolf is subdued, but the land remains haunted by the old bargain between fear, hunger, and memory.';
    }
    return 'CHAPTER SUMMARY — The day remains unresolved. The forest is watching, and it has not finished speaking yet.';
  })();

  return (
    <div style={styles.container}>
      <header style={styles.header}>
        <div>
          <h1 style={styles.title}>RED RIDING HOOD: A Text-Based Adventure Game</h1>
          <span style={styles.subtitle}>CS121 Multi-Paradigm System </span>
        </div>
        <div style={styles.accountBox}>
          <label htmlFor="account-id" style={styles.label}>Account ID: </label>
          <input
            id="account-id"
            style={styles.userInput}
            value={userId}
            maxLength={40}
            disabled={busy}
            onChange={(e) => setUserId(e.target.value)}
            onBlur={() => { if (userId !== loadedIdRef.current) loadPlayer(userId); }}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); } }}
          />
          <button onClick={resetTimeline} disabled={busy} style={styles.resetBtn}>Reset Timeline</button>
        </div>
      </header>

      <div style={styles.mainGrid}>
        <div style={styles.terminalWindow}>
          <div style={styles.logArea} role="log" aria-live="polite" aria-label="Game log">
            {logs.map((log, index) => (
              <pre
                key={index}
                style={{
                  ...styles.logText,
                  color:
                    log.sender === 'PLAYER' ? '#ff6b6b'
                    : log.sender === 'SYSTEM' ? '#ffd166'
                    : log.sender === 'ERROR' ? '#ff4d4d'
                    : '#4ecdc4'
                }}
              >
                {log.text}
              </pre>
            ))}
            <div ref={terminalEndRef} />
          </div>

          <form onSubmit={sendCommand} style={styles.inputRow}>
            <span style={styles.promptArrow}>{'>'}</span>
            <input
              ref={inputRef}
              aria-label="Game command"
              style={styles.commandInput}
              value={input}
              maxLength={200}
              disabled={busy}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Enter command (e.g., look around, examine basket, talk to wolf, walk to cottage)..."
              autoFocus
            />
            <button type="submit" disabled={busy} style={styles.sendBtn}>{busy ? '...' : 'Execute'}</button>
          </form>
        </div>

        <aside style={styles.sidebar}>
          <div style={styles.card}>
            <h3 style={styles.cardTitle}>UN SDG Goal 3 Telemetry</h3>
            <p style={styles.metricLabel}>Grandmother Wellness Score:</p>
            <div style={styles.progressBarBg}>
              <div style={{ ...styles.progressBarFill, width: `${gs ? gs.grandmotherWellness : INITIAL_WELLNESS}%` }} />
            </div>
            <p style={styles.metricValue}>{gs ? gs.grandmotherWellness : INITIAL_WELLNESS} / 100</p>
          </div>

          <div style={styles.card}>
            <h3 style={styles.cardTitle}>ML BPE Tokenizer & Intent</h3>
            <p><strong>Prolog Intent:</strong> <span style={styles.badge}>{mlTelemetry.resolvedIntent}</span></p>
            {mlTelemetry.corrections.length > 0 && (
              <p style={{ fontSize: '0.8rem', color: '#ffd166', margin: '0 0 8px 0' }}>
                <strong>Typo fixed:</strong> {mlTelemetry.corrections.map((c) => `${c.from} → ${c.to}`).join(', ')}
              </p>
            )}
            <p><strong>Subword Tokens (as typed):</strong></p>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px', marginBottom: '8px' }}>
              {mlTelemetry.subwords.length > 0 ? (
                mlTelemetry.subwords.map((sw, i) => (
                  <span key={i} style={styles.chip}>{sw}</span>
                ))
              ) : (
                <span style={{ color: '#8b949e', fontSize: '0.8rem' }}>None</span>
              )}
            </div>
            <p style={{ fontSize: '0.8rem', color: '#8b949e', margin: 0 }}>
              <strong>Token IDs:</strong> [{mlTelemetry.tokenIds.join(', ')}]
            </p>
          </div>

          <div style={styles.card}>
            <h3 style={styles.cardTitle}>Prolog Chaos Engine</h3>
            <p><strong>Active Timeline:</strong> <span style={styles.badge}>{chaosOutcome}</span></p>
            <p><strong>Location:</strong> {gs ? gs.location : 'forest_path'}</p>
            <p><strong>Faction:</strong> {gs ? (gs.factionAffinity || 'neutral') : 'neutral'}</p>
            <p><strong>Loop Count:</strong> {gs ? gs.loopCount : 0}</p>
            <p><strong>Stayed on Path:</strong> {gs ? String(gs.stayedOnPath) : 'true'}</p>
            <p><strong>Talked to Wolf:</strong> {gs ? String(gs.talkedToWolf) : 'false'}</p>
            <p><strong>Clues Noticed:</strong> {gs ? gs.cluesNoticed : 0} / 3</p>
            <p><strong>Forest Delay:</strong> {gs ? gs.forestDelay : 0} turns</p>
            <p><strong>Hummed Tune:</strong> {gs ? String(gs.hummedTune) : 'false'}</p>
            <p><strong>Warned Woodcutter:</strong> {gs ? String(gs.warnedWoodcutter) : 'false'}</p>
            <p><strong>Grandmother Free:</strong> {gs ? String(gs.grandmotherUntied) : 'false'}</p>
          </div>

          <div style={styles.card}>
            <h3 style={styles.cardTitle}>Chapter Summary</h3>
            <p style={{ margin: 0, color: '#f2d27a', lineHeight: 1.6 }}>{chapterSummary || 'The chapter has not concluded yet.'}</p>
          </div>

          <div style={styles.card}>
            <h3 style={styles.cardTitle}>Loop Memories</h3>
            {(gs && gs.memoryFragments && gs.memoryFragments.length > 0) ? (
              <ul style={styles.list}>
                {gs.memoryFragments.map((fragment, i) => (
                  <li key={i}>{fragment}</li>
                ))}
              </ul>
            ) : (
              <p style={{ margin: 0, color: '#8b949e' }}>No memories yet. The woods are still waiting to reveal themselves.</p>
            )}
          </div>

          <div style={styles.card}>
            <h3 style={styles.cardTitle}>Basket Inventory (OOP)</h3>
            <ul style={styles.list}>
              {(gs ? gs.inventory : ['bread', 'wine', 'cakes', 'remedies']).map((item, i) => (
                <li key={i}>{item.toUpperCase()}</li>
              ))}
            </ul>
          </div>
        </aside>
      </div>
    </div>
  );
}

const styles = {
  container: { backgroundColor: '#0d1117', color: '#c9d1d9', minHeight: '100vh', padding: '20px', fontFamily: 'monospace' },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '2px solid #8b0000', paddingBottom: '12px', marginBottom: '20px' },
  title: { margin: 0, color: '#ff4d4d', fontSize: '1.4rem' },
  subtitle: { fontSize: '0.8rem', color: '#8b949e' },
  accountBox: { display: 'flex', gap: '8px', alignItems: 'center' },
  label: { fontSize: '0.85rem' },
  userInput: { background: '#161b22', border: '1px solid #30363d', color: '#fff', padding: '6px 10px', fontFamily: 'monospace' },
  resetBtn: { background: '#8b0000', color: '#fff', border: 'none', padding: '6px 12px', cursor: 'pointer', fontFamily: 'monospace' },
  mainGrid: { display: 'grid', gridTemplateColumns: '2fr 1fr', gap: '20px', height: '78vh' },
  terminalWindow: { background: '#05080c', border: '1px solid #30363d', display: 'flex', flexDirection: 'column', justifyContent: 'space-between', padding: '16px', borderRadius: '6px' },
  logArea: { overflowY: 'auto', flexGrow: 1, paddingRight: '10px' },
  logText: { whiteSpace: 'pre-wrap', margin: '0 0 12px 0', lineHeight: '1.5', fontSize: '0.95rem' },
  inputRow: { display: 'flex', alignItems: 'center', borderTop: '1px solid #30363d', paddingTop: '12px', gap: '8px' },
  promptArrow: { color: '#ff4d4d', fontWeight: 'bold', fontSize: '1.2rem' },
  commandInput: { flexGrow: 1, background: 'transparent', border: 'none', color: '#fff', fontSize: '1rem', outline: 'none', fontFamily: 'monospace' },
  sendBtn: { background: '#238636', color: '#fff', border: 'none', padding: '8px 16px', cursor: 'pointer', fontFamily: 'monospace' },
  sidebar: { display: 'flex', flexDirection: 'column', gap: '16px', overflowY: 'auto' },
  card: { background: '#161b22', border: '1px solid #30363d', padding: '14px', borderRadius: '6px' },
  cardTitle: { margin: '0 0 10px 0', color: '#ff6b6b', fontSize: '1rem', borderBottom: '1px solid #30363d', paddingBottom: '6px' },
  metricLabel: { margin: '0 0 6px 0', fontSize: '0.85rem' },
  progressBarBg: { background: '#0d1117', height: '14px', borderRadius: '7px', overflow: 'hidden', border: '1px solid #30363d' },
  progressBarFill: { background: '#2ea043', height: '100%', transition: 'width 0.3s ease' },
  metricValue: { textAlign: 'right', margin: '4px 0 0 0', fontSize: '0.85rem', fontWeight: 'bold' },
  badge: { background: '#1f6feb', color: '#fff', padding: '2px 6px', borderRadius: '4px', fontSize: '0.8rem' },
  chip: { background: '#21262d', border: '1px solid #30363d', padding: '2px 6px', borderRadius: '4px', fontSize: '0.8rem', color: '#79c0ff' },
  list: { margin: 0, paddingLeft: '18px', lineHeight: '1.6' }
};