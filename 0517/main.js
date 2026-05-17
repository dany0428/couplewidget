// main.js (type=module)
// Frontend-only widget + Supabase connection setup for StackBlitz/browser.
// Safe when run in a browser: no Tauri import at top level; guarded dynamic imports and local fallback.

const isTauri = typeof window.__TAURI__ !== 'undefined';

// UI references
const character = document.getElementById('character');
const heartsContainer = document.getElementById('hearts');
const connectBtn = document.getElementById('connectBtn');
const simulateBtn = document.getElementById('simulateBtn');
const statusEl = document.getElementById('status');
const supabaseUrlInput = document.getElementById('supabaseUrl');
const supabaseKeyInput = document.getElementById('supabaseKey');
const partnerCodeInput = document.getElementById('partnerCode');

let supabase = null;
let supabaseChannel = null;
let usingFallback = true;
let myClientId = generateClientId(); // ephemeral ID for demo/testing

init();

function logStatus(msg){
  statusEl.textContent = 'Status: ' + msg;
  console.debug('[widget]', msg);
}

function generateClientId(){
  return 'client_' + Math.random().toString(36).slice(2,9);
}

function init(){
  // Try to restore from sessionStorage
  supabaseUrlInput.value = sessionStorage.getItem('supabaseUrl') || '';
  supabaseKeyInput.value = sessionStorage.getItem('supabaseKey') || '';
  partnerCodeInput.value = sessionStorage.getItem('partnerCode') || '';

  // Events
  connectBtn.addEventListener('click', connectClicked);
  simulateBtn.addEventListener('click', simulateIncoming);

  character.addEventListener('click', onPet);
  character.addEventListener('keydown', (e)=>{ if(e.key === 'Enter' || e.key === ' ') onPet(); });

  // Start in fallback mode
  useLocalFallback();
  logStatus('disconnected (using local fallback)');
}

// Called when the user clicks the character
async function onPet(e){
  // Visual feedback immediately
  spawnHeartAt(characterCenter());

  // Build a payload
  const payload = {
    type: 'pet',
    from: myClientId,
    to: partnerCodeInput.value || null,
    ts: new Date().toISOString()
  };

  // Send to Supabase (if connected) or local fallback
  await sendInteraction(payload);
}

// Get approximate center coordinates of the character relative to hearts container
function characterCenter(){
  const r = character.getBoundingClientRect();
  const c = heartsContainer.getBoundingClientRect();
  return {
    x: r.left + r.width/2 - c.left,
    y: r.top + r.height/3 - c.top
  };
}

/* ------------------------
   Supabase connection logic
   - dynamic import of supabase-js via CDN only when needed
   - fallback local bus if URL/key are not provided
   ------------------------ */

async function connectClicked(){
  const url = supabaseUrlInput.value.trim();
  const key = supabaseKeyInput.value.trim();

  // persist in session (friendly for dev in the browser)
  sessionStorage.setItem('supabaseUrl', url);
  sessionStorage.setItem('supabaseKey', key);
  sessionStorage.setItem('partnerCode', partnerCodeInput.value.trim());

  if (!url || !key){
    useLocalFallback();
    logStatus('no keys provided — using local fallback');
    return;
  }

  // Try to dynamically import Supabase client
  try {
    logStatus('connecting to Supabase...');
    // +esm endpoint gives an ES module compatible import
    const mod = await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js/+esm');
    if (!mod || !mod.createClient) throw new Error('Invalid supabase module');

    supabase = mod.createClient(url, key, {
      realtime: { params: { eventsPerSecond: 10 } } // small tuning
    });

    // Test the connection with a small request (get current time via SQL? or list tables)
    // We'll attempt a simple RPC call to ensure auth works; if it fails we still continue but show status
    // Setup subscription
    await subscribeToInteractions();

    usingFallback = false;
    logStatus('connected to Supabase realtime (listening to interactions)');
  } catch (err) {
    console.error('Supabase connect failed', err);
    useLocalFallback();
    logStatus('failed to connect — using local fallback');
  }
}

async function subscribeToInteractions(){
  // Tear down previous
  if (supabaseChannel && supabaseChannel.unsubscribe) {
    try { await supabaseChannel.unsubscribe(); } catch(e){ /* ignore */ }
    supabaseChannel = null;
  }

  if (!supabase) return;

  // Supabase v2 realtime subscription
  // Subscribe to INSERT events on public.interactions
  try {
    supabaseChannel = supabase.channel('public:interactions');

    supabaseChannel.on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'interactions' },
      (payload) => {
        // payload.record contains inserted row (depending on your DB schema)
        handleIncomingInteraction(payload);
      }
    );

    await supabaseChannel.subscribe();
  } catch (err) {
    console.warn('Realtime subscribe error:', err);
    // Some Supabase instances may require other config or RLS; that's fine for preview.
  }
}

/* sendInteraction:
   If supabase is connected, insert a row into interactions table.
   Otherwise emit on local fallback bus for UI testing.
*/
async function sendInteraction(payload){
  if (!usingFallback && supabase){
    try {
      // insert into "interactions" table. The table must exist in your Supabase DB.
      const row = {
        type: payload.type,
        from_client: payload.from,
        to_code: payload.to,
        meta: payload.meta || {},
        created_at: payload.ts
      };
      const res = await supabase.from('interactions').insert([row]);
      if (res.error) {
        console.warn('Insert error:', res.error);
      }
      return res;
    } catch (err) {
      console.error('Supabase insert failed', err);
      // fallback to local emit so UI still shows behavior
      emitLocalInteraction(payload);
    }
  } else {
    // local fallback
    emitLocalInteraction(payload);
  }
}

/* -----------------------------
   Local fallback event bus
   When not connected to Supabase, this simulates receiving the interaction.
   Useful for StackBlitz preview and offline UI testing.
   ----------------------------- */
function useLocalFallback(){
  usingFallback = true;
  // ensure there's a global bus
  if (!window.__localWidgetBus) {
    window.__localWidgetBus = {
      listeners: [],
      emit(payload){
        (this.listeners || []).forEach(fn => {
          try { fn({ record: payload }); } catch(e){ console.error(e); }
        });
      },
      on(fn){ this.listeners.push(fn); return ()=>{ this.listeners = this.listeners.filter(x=>x!==fn); }; }
    };
  }
  // subscribe locally
  window.__localUnsub && window.__localUnsub();
  window.__localUnsub = window.__localWidgetBus.on((payload)=> {
    // simulate a real Supabase payload envelope
    handleIncomingInteraction({ record: payload });
  });
}

/* Programmatic emit for local fallback */
function emitLocalInteraction(payload){
  // For demo purposes we trigger the handler on the opposite client, but here it is local.
  // In a real multi-client scenario each client runs this code and receives the event via Supabase.
  if (window.__localWidgetBus) window.__localWidgetBus.emit(payload);
}

/* -----------------------------
   Handling incoming interactions (from supabase or fallback)
   ----------------------------- */
function handleIncomingInteraction(envelope){
  // envelope.record is the inserted row (or our fallback payload)
  const record = envelope && (envelope.record || envelope);
  if (!record) return;

  // Normalize for fallback vs real DB row shape:
  // Our fallback sends {type, from, to, ts}
  // DB insert row is expected to have columns like type, from_client, to_code, meta, created_at
  const type = record.type || record.type;
  const from = record.from || record.from_client || 'unknown';
  const to = record.to || record.to_code || null;

  // If a partner code is set, only react to events intended to you (optional)
  const myPartnerCode = partnerCodeInput.value.trim();
  if (myPartnerCode && to && to !== myPartnerCode && to !== null) {
    // Not for me
    console.debug('Ignoring event not intended for this client (to=%s)', to);
    return;
  }

  if (type === 'pet') {
    // Trigger heart effect in response
    spawnHeartAt(characterCenter());
    logStatus(`received pet from ${from}`);
  } else {
    // other event types could be handled here
    spawnHeartAt(characterCenter());
  }
}

/* -----------------------------
   Heart spawn & visuals
   ----------------------------- */
function spawnHeartAt(pos){
  // pos: {x,y} relative to heartsContainer (client rect)
  const heart = document.createElement('div');
  heart.className = 'heart';
  const size = 18 + Math.floor(Math.random()*18);
  heart.style.width = `${size}px`;
  heart.style.height = `${size}px`;
  heart.style.left = `${pos.x - size/2}px`;
  heart.style.top = `${pos.y - size/2}px`;
  const hue = 330 + Math.round(Math.random()*20);
  const color = `hsl(${hue} 90% 68%)`;

  // Inline SVG heart to avoid external assets
  heart.innerHTML = `
    <svg viewBox="0 0 24 24" fill="${color}" xmlns="http://www.w3.org/2000/svg">
      <path d="M12 21s-7.5-4.8-9.3-7C1.1 11.9 3.2 7 7.2 7c2.1 0 3.3 1.2 4.1 2 .8-.8 2-2 4.1-2 4 0 6.1 4.9 4.5 7.9C19.5 16.2 12 21 12 21z"/>
    </svg>
  `;

  heartsContainer.appendChild(heart);

  // randomize duration and horizontal drift
  const duration = 1400 + Math.floor(Math.random()*900);
  const drift = (Math.random()*80 - 40);

  heart.animate(
    [
      { transform: `translateX(0px) translateY(0px) scale(0.9) rotate(-6deg)`, opacity: 0.95 },
      { transform: `translateX(${drift*0.3}px) translateY(-36px) scale(1.05) rotate(-2deg)`, opacity: 1, offset: 0.3 },
      { transform: `translateX(${drift}px) translateY(-160px) scale(0.6) rotate(8deg)`, opacity: 0 }
    ],
    {
      duration,
      easing: 'cubic-bezier(0.2, 0.9, 0.2, 1)',
      iterations: 1,
      fill: 'forwards'
    }
  );

  // cleanup after animation
  setTimeout(()=> {
    heart.remove();
  }, duration + 50);
}

/* Helpers: simulate an incoming "pet" event from partner */
function simulateIncoming(){
  const payload = {
    type: 'pet',
    from: 'simulated_partner',
    to: partnerCodeInput.value || null,
    ts: new Date().toISOString()
  };
  // Directly call handler via same envelope format as fallback
  if (usingFallback) {
    emitLocalInteraction(payload);
  } else if (supabase) {
    // If connected to Supabase but you want to test, we can still spawn locally
    handleIncomingInteraction({ record: payload });
  }
}

/* Expose a couple of helpers for debugging in StackBlitz console */
window._coupleWidget = {
  sendInteraction: (p) => sendInteraction(p),
  simulateIncoming,
  getClientId: () => myClientId
};