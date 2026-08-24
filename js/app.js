import { initializeApp } from "https://www.gstatic.com/firebasejs/12.16.0/firebase-app.js";
import {
  getFirestore, doc, getDoc, getDocFromServer, setDoc, onSnapshot, deleteField, deleteDoc
} from "https://www.gstatic.com/firebasejs/12.16.0/firebase-firestore.js";
import {
  getAuth, signInWithEmailAndPassword, createUserWithEmailAndPassword,
  onAuthStateChanged, signOut, updateProfile,
  GoogleAuthProvider, signInWithPopup
} from "https://www.gstatic.com/firebasejs/12.16.0/firebase-auth.js";
import {
  getMessaging, getToken, onMessage, isSupported as messagingIsSupported
} from "https://www.gstatic.com/firebasejs/12.16.0/firebase-messaging.js";

const firebaseConfig = {
  apiKey: "AIzaSyAiX0OPqh8dvHaDaMcjJznTNp7XE1iuPE4",
  authDomain: "study-board-6c9d0.firebaseapp.com",
  projectId: "study-board-6c9d0",
  storageBucket: "study-board-6c9d0.firebasestorage.app",
  messagingSenderId: "706066762938",
  appId: "1:706066762938:web:6e0cde4838353927b74683"
};
const fbApp = initializeApp(firebaseConfig);
const db = getFirestore(fbApp);
const auth = getAuth(fbApp);

// ---------- PWA: service worker + push notifications ----------
let swRegistration = null;
if('serviceWorker' in navigator){
  window.addEventListener('load', async ()=>{
    try{ swRegistration = await navigator.serviceWorker.register('./sw.js'); }
    catch(e){ console.warn('SW registration failed', e); }
  });
}

const VAPID_KEY = 'BHaRFc-faH5vI-yIhWjd0n1BF3CQ0zmkHHJcJOVT9mYLaloj_BB0qaSjfAJ4Utm1BVyNLr1-vq-cNiFToCDgCFs';

async function pushPermissionState(){
  if(!('Notification' in window)) return 'unsupported';
  return Notification.permission;
}

async function enablePushNotifications(){
  if(!('Notification' in window)) return { ok:false, reason:'unsupported' };
  if(!VAPID_KEY || VAPID_KEY==='PASTE_YOUR_VAPID_KEY_HERE'){
    console.warn('Push notifications are not configured yet.');
    return { ok:false, reason:'not_configured' };
  }
  try{
    const supported = await messagingIsSupported();
    if(!supported) return { ok:false, reason:'unsupported' };
    const perm = await Notification.requestPermission();
    if(perm !== 'granted') return { ok:false, reason:perm };
    if(!swRegistration) swRegistration = await navigator.serviceWorker.ready;
    const messaging = getMessaging(fbApp);
    const token = await getToken(messaging, { vapidKey: VAPID_KEY, serviceWorkerRegistration: swRegistration });
    if(!token) return { ok:false, reason:'error', detail:'getToken returned empty' };
    if(window.__meId){
      await setDoc(doc(db, 'pushTokens', window.__meId), { token, updatedAt: Date.now() }, { merge:true });
    }
    onMessage(messaging, (payload)=>{
      const title = payload.notification?.title || 'Study Board';
      const body = payload.notification?.body || '';
      if(swRegistration) swRegistration.showNotification(title, { body, icon:'./icons/icon-192.png' });
    });
    return { ok:true };
  }catch(e){
    console.warn('Push setup failed', e);
    return { ok:false, reason:'error', detail: (e && (e.code || e.message)) || String(e) };
  }
}

const storage = {
  async get(key, shared){
    const ref = keyToRef(key, shared);
    const snap = await getDoc(ref);
    return snap.exists() ? { key, value: JSON.stringify(snap.data().value), shared } : null;
  },
  async set(key, value, shared){
    const ref = keyToRef(key, shared);
    const opts = (key === 'study-board-data-v1') ? { merge:true } : undefined;
    await setDoc(ref, { value: JSON.parse(value) }, opts);
    return { key, value, shared };
  }
};
function keyToRef(key, shared){
  if(key === 'study-board-data-v1') return doc(db, 'boards', window.__meId || 'unknown');
  if(key === 'study-board-profile') return doc(db, 'profiles', window.__meId || 'unknown');
  if(key === 'study-board-users') return doc(db, 'registry', 'users');
  if(key.startsWith('board:')) return doc(db, 'boards', key.slice(6));
  if(key.startsWith('shared-tasks:')) return doc(db, 'sharedTasks', key.slice(13));
  return doc(db, 'misc', key);
}
function escapeHtml(s){
  return String(s).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
window.storage = storage;

(function(){
  const COLORS = ['#FF5A5F','#7FB3D5','#8FCB9B','#B8A0D9','#E6A0C4','#E8C468'];
  const DAY_NAMES = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const STORAGE_KEY = 'study-board-data-v1';
  const USERS_KEY = 'study-board-users';

  let state = {
    subjects: [
      {id:'s1', name:'General', color:'#7FB3D5'}
    ],
    weeklyTemplate: [], 
    dailyExtra: {},     
    completion: {},     
    sessions: {},        
    goals: { dailyMin: 120, weeklyMin: 600 }, 
    weeklyGoals: [], 
    focusPresetNames: ['30 min','1 hour','custom'],
    weekStartDay: 0
  };

  let selectedDate = new Date();
  let currentScreen = 'timer';

  let me = null;              
  let allProfiles = [];       
  let usersList = [];         
  let viewingId = null;       
  let friendCache = {};       
  let myReads = {};           

  // ---------- groups ----------
  let myGroupIds = [];        
  let activeGroupId = null;   
  let activeGroupData = null; 
  let groupUnsub = null;

  function isViewingSelf(){ return !viewingId || (me && viewingId === me.id); }
  function activeData(){ return isViewingSelf() ? state : (friendCache[viewingId] || {subjects:[],weeklyTemplate:[],weeklyGoals:[],dailyExtra:{},completion:{},sessions:{}}); }
  function isScheduleHiddenFor(uid){
    if(!activeGroupData || !activeGroupData.members) return false;
    const m = activeGroupData.members[uid];
    return !!(m && m.hideSchedule);
  }

  // ---------- multi-device sync ----------
  let lastSyncAt = null;
  let syncStatus = 'stale'; 
  let applyingRemote = false;
  function mergeArraysById(localArr, remoteArr){
    const byId = new Map();
    (remoteArr||[]).forEach(it=>{ if(it && it.id!=null) byId.set(it.id, it); });
    (localArr||[]).forEach(it=>{ if(it && it.id!=null && !byId.has(it.id)) byId.set(it.id, it); });
    return Array.from(byId.values());
  }
  function mergeKeyedArrayMaps(localMap, remoteMap){
    const out = {};
    const keys = new Set([...Object.keys(localMap||{}), ...Object.keys(remoteMap||{})]);
    keys.forEach(k=>{ out[k] = mergeArraysById((localMap||{})[k], (remoteMap||{})[k]); });
    return out;
  }
  function mergeRemoteIntoState(remote){
    if(!remote) return;
    state.subjects = mergeArraysById(state.subjects, remote.subjects);
    state.weeklyTemplate = mergeArraysById(state.weeklyTemplate, remote.weeklyTemplate);
    state.weeklyGoals = mergeArraysById(state.weeklyGoals, remote.weeklyGoals);
    state.dailyExtra = mergeKeyedArrayMaps(state.dailyExtra, remote.dailyExtra);
    state.sessions = mergeKeyedArrayMaps(state.sessions, remote.sessions);
    state.completion = Object.assign({}, remote.completion||{}, state.completion||{});
    if(remote.goals && (!state.goals || Object.keys(state.goals).length===0)) state.goals = remote.goals;
  }
  function migrateLegacyWeeklyTemplate(fromFreshServerData){
    if(!state.weeklyTemplate || !state.weeklyTemplate.length) return;
    const before = state.weeklyTemplate.length;
    const cleaned = state.weeklyTemplate.filter(b=> !!b.weekStart);
    if(cleaned.length === before) return;
    state.weeklyTemplate = cleaned;
    if(fromFreshServerData) saveState();
  }
  function setSyncStatus(status){
    syncStatus = status;
    if(status==='ok') lastSyncAt = Date.now();
    renderSyncIndicator();
  }
  function renderSyncIndicator(){
    const btn = document.getElementById('syncBtn');
    const dot = document.getElementById('syncDot');
    if(!btn || !dot) return;
    btn.classList.toggle('syncing', syncStatus==='syncing');
    dot.className = 'sync-dot' + (syncStatus==='ok' ? ' ok' : syncStatus==='err' ? ' err' : (lastSyncAt ? ' stale' : ''));
    btn.title = syncStatus==='syncing' ? 'Syncing…'
      : syncStatus==='err' ? 'Sync failed — tap to retry'
      : lastSyncAt ? `Synced ${timeAgo(lastSyncAt)} — tap to sync now`
      : 'Not synced yet — tap to sync';
  }
  let boardUnsub = null;
  function subscribeOwnBoard(){
    if(boardUnsub) boardUnsub();
    boardUnsub = onSnapshot(doc(db, 'boards', me.id), (snap)=>{
      if(!snap.exists()) return;
      applyingRemote = true;
      mergeRemoteIntoState(snap.data().value);
      applyingRemote = false;
      setSyncStatus('ok');
      render();
    }, (err)=>{
      console.warn('board sync error', err);
      setSyncStatus('err');
    });
  }
  async function manualSync(){
    if(!me) return;
    setSyncStatus('syncing');
    try{
      const snap = await getDocFromServer(doc(db, 'boards', me.id));
      if(snap.exists() && snap.data().value) mergeRemoteIntoState(snap.data().value);
      await flushStateNow();
      setSyncStatus('ok');
      render();
    }catch(e){
      console.error('manual sync failed', e);
      setSyncStatus('err');
    }
  }
  document.getElementById('syncBtn').addEventListener('click', manualSync);

  // ---------- persistence: my own private working copy ----------
  function showLoadBlocker(msg){
    document.getElementById('loadBlockerMsg').textContent = msg;
    document.getElementById('loadBlocker').style.display = 'flex';
  }
  function hideLoadBlocker(){
    document.getElementById('loadBlocker').style.display = 'none';
  }
  function waitForOnline(){
    return new Promise((resolve)=>{
      if(navigator.onLine){ setTimeout(resolve, 1500); return; }
      const handler = ()=>{ window.removeEventListener('online', handler); resolve(); };
      window.addEventListener('online', handler);
    });
  }
  window.addEventListener('online', ()=>{
    document.getElementById('offlineBanner').style.display = 'none';
    if(me && stateReadyToPersist) manualSync();
  });
  window.addEventListener('offline', ()=>{
    document.getElementById('offlineBanner').style.display = 'block';
  });

  async function loadState(){
    stateReadyToPersist = false;
    showLoadBlocker('Loading your data…');
    let snap = null;
    let attempts = 0;
    while(!snap){
      try{
        snap = await getDocFromServer(doc(db, 'boards', me.id));
      }catch(e){
        attempts++;
        showLoadBlocker(attempts===1
          ? "You're offline — waiting to reconnect…"
          : "Still waiting for a connection… your data is safe on the server, we just can't reach it yet.");
        await waitForOnline();
      }
    }
    hideLoadBlocker();
    if(snap.exists() && snap.data().value){
      state = Object.assign(state, snap.data().value);
    }
    stateReadyToPersist = true;
    migrateLegacyWeeklyTemplate(true);
    maybeWriteDailyBackup();
    await loadUsersList();
    await loadNotificationSettings();
    await loadMyGroupIds();
    await subscribeActiveGroup();
    await loadMyReads();
    renderHeaderAvatar();
    render();
    startLiveTimers();
    subscribeSelfLiveStatus();
    subscribeSelfNudges();
    subscribeOwnBoard();
    renderSnapRow();
    scheduleLocalTaskAlerts();
    setLiveStatus({ todayTotalMin: todayTotalMinutes() });
    refreshAllFriendBoards();
    if(friendBoardsPollHandle) clearInterval(friendBoardsPollHandle);
    friendBoardsPollHandle = setInterval(refreshAllFriendBoards, 60000);
    setSyncStatus('ok');
    checkJoinLinkParam();
  }
  function checkJoinLinkParam(){
    const params = new URLSearchParams(location.search);
    const code = params.get('join');
    if(!code) return;
    history.replaceState(null, '', location.pathname);
    if(myGroupIds.length && activeGroupData && activeGroupData.inviteCode===code.toUpperCase()) return;
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.innerHTML = `
      <div class="modal">
        <h3>Join this group?</h3>
        <div style="font-size:12px; color:var(--chalk-faint); margin-bottom:12px;">Invite code: <b style="color:var(--chalk);">${escapeHtml(code.toUpperCase())}</b></div>
        <div class="field-row">
          <label>Password <span style="opacity:.6; text-transform:none;">(only if this group has one)</span></label>
          <input type="text" id="ql-password" placeholder="Leave blank if none">
        </div>
        <div class="status" id="ql-status" style="font-size:12px; color:var(--danger); min-height:16px;"></div>
        <div class="modal-actions">
          <button class="btn btn-ghost" id="ql-cancel">Not now</button>
          <button class="btn btn-primary" id="ql-join">Join</button>
        </div>
      </div>
    `;
    document.body.appendChild(backdrop);
    function close(){ document.body.removeChild(backdrop); }
    backdrop.querySelector('#ql-cancel').addEventListener('click', close);
    backdrop.querySelector('#ql-join').addEventListener('click', async ()=>{
      const password = backdrop.querySelector('#ql-password').value;
      const statusEl = backdrop.querySelector('#ql-status');
      backdrop.querySelector('#ql-join').disabled = true;
      try{
        const g = await joinGroupByCode(code, password);
        statusEl.style.color = 'var(--ok)';
        statusEl.textContent = `Joined ${g.name}!`;
        setTimeout(close, 700);
      }catch(e){
        statusEl.style.color = 'var(--danger)';
        statusEl.textContent = e.message;
        backdrop.querySelector('#ql-join').disabled = false;
      }
    });
  }

  async function maybeWriteDailyBackup(){
    if(!me) return;
    const todayKey = fmtDate(new Date());
    const backupRef = doc(db, 'boardBackups', me.id + '_' + todayKey);
    try{
      const existing = await getDoc(backupRef);
      if(existing.exists()) return;
      await setDoc(backupRef, { uid: me.id, date: todayKey, savedAt: Date.now(), value: state });
    }catch(e){ console.warn('daily backup failed', e); }
  }

  async function loadMyReads(){
    try{
      const snap = await getDoc(doc(db, 'commentReads', me.id));
      myReads = snap.exists() ? snap.data() : {};
    }catch(e){ myReads = {}; }
  }
  async function markRead(cid){
    myReads[cid] = Date.now();
    try{ await setDoc(doc(db, 'commentReads', me.id), myReads); }catch(e){}
  }
  let saveTimeout = null;
  let stateReadyToPersist = false; 
  function saveState(){
    if(!stateReadyToPersist){ return; }
    clearTimeout(saveTimeout);
    setSyncStatus('syncing');
    saveTimeout = setTimeout(async ()=>{
      try{
        await window.storage.set(STORAGE_KEY, JSON.stringify(state), false);
        pushSharedBoard();
        setSyncStatus('ok');
      }
      catch(e){ console.error('save failed', e); setSyncStatus('err'); }
    }, 250);
  }
  async function flushStateNow(){
    if(!stateReadyToPersist){ return; }
    clearTimeout(saveTimeout);
    try{
      await window.storage.set(STORAGE_KEY, JSON.stringify(state), false);
      pushSharedBoard();
      setSyncStatus('ok');
    }catch(e){ console.error('flush failed', e); setSyncStatus('err'); }
  }
  document.addEventListener('visibilitychange', ()=>{
    if(document.visibilityState==='hidden' && me) flushStateNow();
  });

  // ---------- auth: login / sign up / logout ----------
  let booted = false;
  const authScreen = document.getElementById('authScreen');
  const appRoot = document.getElementById('app');
  const authError = document.getElementById('authError');
  function showAuth(){
    authScreen.style.display = 'flex';
    appRoot.style.display = 'none';
  }
  function showApp(){
    authScreen.style.display = 'none';
    appRoot.style.display = 'flex';
  }
  function setAuthError(msg){ authError.textContent = msg || ''; }

  let authMode = 'login';
  document.getElementById('authToggle').addEventListener('click', ()=>{
    authMode = authMode==='login' ? 'signup' : 'login';
    document.getElementById('nameRow').style.display = authMode==='signup' ? 'block' : 'none';
    document.getElementById('authSubmit').textContent = authMode==='signup' ? 'Create account' : 'Log in';
    document.getElementById('authTitle').textContent = authMode==='signup' ? 'Join the board' : 'Welcome back';
    document.getElementById('authToggle').textContent = authMode==='signup' ? 'Already have an account? Log in' : 'New here? Create an account';
    setAuthError('');
  });

  // ----- GOOGLE AUTH CODE START -----
  document.getElementById('googleAuthBtn').addEventListener('click', async ()=>{
    setAuthError('');
    document.getElementById('googleAuthBtn').disabled = true;
    try {
      const provider = new GoogleAuthProvider();
      const cred = await signInWithPopup(auth, provider);
      booted = true;
      window.__meId = cred.user.uid;
      
      const res = await window.storage.get('study-board-profile', false);
      me = res && res.value ? JSON.parse(res.value) : { 
        id: cred.user.uid, 
        name: cred.user.displayName || 'Student', 
        color: COLORS[0],
        photo: cred.user.photoURL || null
      };
      
      showApp();
      await loadState();
    } catch(e) {
      setAuthError(e.message.replace('Firebase: ','').replace(/\(auth\/.*\)\.?/,'').trim() || 'Google sign-in failed.');
    }
    document.getElementById('googleAuthBtn').disabled = false;
  });
  // ----- GOOGLE AUTH CODE END -----

  document.getElementById('authSubmit').addEventListener('click', async ()=>{
    const email = document.getElementById('authEmail').value.trim();
    const password = document.getElementById('authPassword').value;
    const name = document.getElementById('authName').value.trim();
    setAuthError('');
    if(!email || !password){ setAuthError('Enter an email and password.'); return; }
    if(authMode==='signup' && !name){ setAuthError('Enter your name.'); return; }

    document.getElementById('authSubmit').disabled = true;
    try{
      if(authMode==='signup'){
        const cred = await createUserWithEmailAndPassword(auth, email, password);
        booted = true;
        window.__meId = cred.user.uid;
        me = { id: cred.user.uid, name, color: COLORS[Math.floor(Math.random()*COLORS.length)] };
        await window.storage.set('study-board-profile', JSON.stringify(me), false);
        await registerUser(me);
        showApp();
        await loadState();
      } else {
        const cred = await signInWithEmailAndPassword(auth, email, password);
        booted = true;
        window.__meId = cred.user.uid;
        const res = await window.storage.get('study-board-profile', false);
        me = res && res.value ? JSON.parse(res.value) : { id: cred.user.uid, name: 'Student', color: COLORS[0] };
        showApp();
        await loadState();
      }
    }catch(e){
      setAuthError(e.message.replace('Firebase: ','').replace(/\(auth\/.*\)\.?/,'').trim() || 'Something went wrong.');
    }
    document.getElementById('authSubmit').disabled = false;
  });

  async function doLogout(){
    try{ exitFocusMode(); }catch(e){}
    try{
      if(timerRunning){
        if(elapsedMs > 3000){ finishSession(false); } else { hardReset(); }
      }
    }catch(e){}
    try{ await flushStateNow(); }catch(e){}
    try{ await setLiveStatus({ studying:false, baseElapsedMs:0 }); }catch(e){}
    try{ if(selfLiveUnsub){ selfLiveUnsub(); selfLiveUnsub = null; } }catch(e){}
    try{ if(boardUnsub){ boardUnsub(); boardUnsub = null; } }catch(e){}
    try{ stopLiveTimers(); }catch(e){}
    try{ if(friendBoardsPollHandle){ clearInterval(friendBoardsPollHandle); friendBoardsPollHandle = null; } }catch(e){}
    friendCache = {};
    liveCache = {};
    viewingId = null;
    try{
      await signOut(auth);
    }catch(e){
      alert('Could not log out: ' + (e.message || 'unknown error') + '\nCheck your connection and try again.');
    }
  }

  document.getElementById('acctBtn').addEventListener('click', openAccountModal);
  document.getElementById('bellBtn').addEventListener('click', openNotificationsModal);

  // ---------- account / profile ----------
  function renderHeaderAvatar(){
    const btn = document.getElementById('acctBtn');
    if(!me){ btn.innerHTML=''; return; }
    if(me.photo){ btn.style.background = 'transparent'; btn.innerHTML = `<img src="${me.photo}" alt="">`; }
    else { btn.style.background = me.color; btn.innerHTML = escapeHtml((me.name||'?').slice(0,1).toUpperCase()); }
  }
  function resizeImageToDataUrl(file, maxSize){
    return new Promise((resolve, reject)=>{
      const reader = new FileReader();
      reader.onerror = ()=>reject(new Error('read failed'));
      reader.onload = ()=>{
        const img = new Image();
        img.onerror = ()=>reject(new Error('decode failed'));
        img.onload = ()=>{
          let w = img.width, h = img.height;
          if(w > h){ if(w>maxSize){ h = Math.round(h*maxSize/w); w = maxSize; } }
          else { if(h>maxSize){ w = Math.round(w*maxSize/h); h = maxSize; } }
          const canvas = document.createElement('canvas');
          canvas.width = w; canvas.height = h;
          canvas.getContext('2d').drawImage(img, 0, 0, w, h);
          resolve(canvas.toDataURL('image/jpeg', 0.82));
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }
  function openAccountModal(){
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.innerHTML = `
      <div class="modal">
        <button class="close-x">×</button>
        <h3>Your account</h3>
        <div class="acct-photo-row">
          <div class="acct-photo" id="acct-photo-preview">${me.photo ? `<img src="${me.photo}" alt="">` : escapeHtml((me.name||'?').slice(0,1).toUpperCase())}</div>
          <div class="acct-photo-actions">
            <input type="file" id="acct-photo-input" accept="image/*" style="display:none;">
            <button class="btn btn-ghost" id="acct-photo-pick">Change photo</button>
            ${me.photo ? `<button class="btn btn-ghost" id="acct-photo-remove">Remove photo</button>` : ''}
          </div>
        </div>
        <div class="field-row">
          <label>Name</label>
          <input type="text" id="acct-name" value="${escapeHtml(me.name)}">
        </div>
        <div class="field-row">
          <label>Avatar color</label>
          <div class="color-row" id="acct-colors">
            ${COLORS.map(c=>`<div class="swatch ${c===me.color?'sel':''}" data-color="${c}" style="background:${c}"></div>`).join('')}
          </div>
        </div>
        <div class="section-divider"></div>
        <h4 style="margin:0 0 10px; font-family:'Kalam'; font-size:14px; color:var(--chalk-dim); font-weight:400;">Study goals</h4>
        <div class="field-row">
          <label>Daily goal (hours, 0 = off)</label>
          <input type="number" id="acct-goal-daily" value="${(state.goals&&state.goals.dailyMin)? (state.goals.dailyMin/60) : 0}" min="0" step="0.5">
        </div>
        <div class="field-row">
          <label>Weekly goal (hours, 0 = off)</label>
          <input type="number" id="acct-goal-weekly" value="${(state.goals&&state.goals.weeklyMin)? (state.goals.weeklyMin/60) : 0}" min="0" step="0.5">
        </div>
        <div class="section-divider"></div>
        <h4 class="modal-subhead">Camera & Snapshots</h4>
        <div class="field-row" style="flex-direction:row; align-items:center; justify-content:space-between;">
          <label style="margin:0;">Share live snapshots while studying</label>
          <label class="switch"><input type="checkbox" id="acct-snap-enabled" ${snapSettings.enabled?'checked':''}><span class="switch-slider"></span></label>
        </div>
        <div class="field-row">
          <label>Camera</label>
          <div class="seg-row" id="acct-snap-facing">
            <button type="button" class="seg-btn ${snapSettings.facing==='user'?'sel':''}" data-facing="user">Front</button>
            <button type="button" class="seg-btn ${snapSettings.facing==='environment'?'sel':''}" data-facing="environment">Back</button>
          </div>
        </div>
        <div class="field-row">
          <label>Snapshot frequency</label>
          <select id="acct-snap-freq">
            <option value="30000" ${snapSettings.freqMs===30000?'selected':''}>Every 30 sec</option>
            <option value="60000" ${snapSettings.freqMs===60000?'selected':''}>Every 1 min</option>
            <option value="120000" ${snapSettings.freqMs===120000?'selected':''}>Every 2 min</option>
            <option value="300000" ${snapSettings.freqMs===300000?'selected':''}>Every 5 min</option>
          </select>
        </div>
        <div style="font-size:11px; color:var(--chalk-faint); margin:-4px 0 4px;">Only visible to friends you're studying with.</div>
        <div class="section-divider"></div>
        <button class="btn btn-ghost" id="acct-manage" style="width:100%; margin-bottom:10px;">👥 My Groups</button>
        <button class="btn btn-danger" id="acct-logout" style="width:100%;">Log out</button>
        <div class="modal-actions">
          <button class="btn btn-ghost" id="acct-cancel">Cancel</button>
          <button class="btn btn-primary" id="acct-save">Save</button>
        </div>
      </div>
    `;
    document.body.appendChild(backdrop);
    function close(){ document.body.removeChild(backdrop); }
    backdrop.querySelector('.close-x').addEventListener('click', close);
    backdrop.querySelector('#acct-cancel').addEventListener('click', close);

    let pickedColor = me.color;
    backdrop.querySelectorAll('#acct-colors .swatch').forEach(sw=>{
      sw.addEventListener('click', ()=>{
        backdrop.querySelectorAll('#acct-colors .swatch').forEach(s=>s.classList.remove('sel'));
        sw.classList.add('sel');
        pickedColor = sw.dataset.color;
      });
    });

    let pickedFacing = snapSettings.facing;
    backdrop.querySelectorAll('#acct-snap-facing .seg-btn').forEach(btn=>{
      btn.addEventListener('click', ()=>{
        backdrop.querySelectorAll('#acct-snap-facing .seg-btn').forEach(b=>b.classList.remove('sel'));
        btn.classList.add('sel');
        pickedFacing = btn.dataset.facing;
      });
    });

    let pickedPhoto = me.photo || null;
    const fileInput = backdrop.querySelector('#acct-photo-input');
    backdrop.querySelector('#acct-photo-pick').addEventListener('click', ()=> fileInput.click());
    fileInput.addEventListener('change', async ()=>{
      const file = fileInput.files[0];
      if(!file) return;
      try{
        pickedPhoto = await resizeImageToDataUrl(file, 160);
        backdrop.querySelector('#acct-photo-preview').innerHTML = `<img src="${pickedPhoto}" alt="">`;
      }catch(e){ alert('Could not read that image — try a different file.'); }
    });
    const removeBtn = backdrop.querySelector('#acct-photo-remove');
    if(removeBtn){
      removeBtn.addEventListener('click', ()=>{
        pickedPhoto = null;
        const nm = backdrop.querySelector('#acct-name').value.trim() || me.name;
        backdrop.querySelector('#acct-photo-preview').innerHTML = escapeHtml(nm.slice(0,1).toUpperCase());
      });
    }

    backdrop.querySelector('#acct-manage').addEventListener('click', ()=>{ close(); openGroupsModal(); });
    backdrop.querySelector('#acct-logout').addEventListener('click', async ()=>{ close(); await doLogout(); });

    backdrop.querySelector('#acct-save').addEventListener('click', async ()=>{
      const newName = backdrop.querySelector('#acct-name').value.trim() || me.name;
      me.name = newName;
      me.color = pickedColor;
      me.photo = pickedPhoto;
      try{ await window.storage.set('study-board-profile', JSON.stringify(me), false); }catch(e){}
      await registerUser(me, true);

      const dailyMin = Math.max(0, Math.round(parseFloat(backdrop.querySelector('#acct-goal-daily').value||'0') * 60));
      const weeklyMin = Math.max(0, Math.round(parseFloat(backdrop.querySelector('#acct-goal-weekly').value||'0') * 60));
      state.goals = { dailyMin, weeklyMin };
      await flushStateNow();

      const wasEnabled = snapSettings.enabled;
      snapSettings.enabled = backdrop.querySelector('#acct-snap-enabled').checked;
      snapSettings.facing = pickedFacing;
      snapSettings.freqMs = parseInt(backdrop.querySelector('#acct-snap-freq').value, 10) || 60000;
      saveSnapSettings(snapSettings);
      if(!snapSettings.enabled){
        stopSnapshotScheduler();
        if(wasEnabled) setLiveStatus({ snapshot:null, snapshotAt:null });
      } else if(camCaptureIntervalHandle){
        stopSnapshotScheduler();
        startSnapshotScheduler();
      } else if(timerRunning){
        startSnapshotScheduler();
      }
      renderSnapRow();
      renderHeaderAvatar();
      render();
      close();
    });
  }

  // ---------- notifications ----------
  const NOTIF_LIMIT = 60;
  const DEFAULT_NOTIFICATION_SETTINGS = {
    timerEnd: true, taskApproaching: true, studyStart: true, taskComment: true, groupChanges: true
  };
  let notificationSettings = Object.assign({}, DEFAULT_NOTIFICATION_SETTINGS);
  let notificationSettingsLoaded = false;
  async function loadNotificationSettings(){
    if(!me) return notificationSettings;
    try{
      const snap = await getDoc(doc(db,'notificationSettings',me.id));
      notificationSettings = Object.assign({}, DEFAULT_NOTIFICATION_SETTINGS, snap.exists()?snap.data():{});
    }catch(e){ notificationSettings = Object.assign({}, DEFAULT_NOTIFICATION_SETTINGS); }
    notificationSettingsLoaded = true;
    return notificationSettings;
  }
  async function saveNotificationSettings(next){
    notificationSettings = Object.assign({}, DEFAULT_NOTIFICATION_SETTINGS, next||{});
    if(me){ try{ await setDoc(doc(db,'notificationSettings',me.id), notificationSettings, {merge:true}); }catch(e){} }
  }
  function notificationCategoryEnabled(category){
    if(category==='timerEnd') return notificationSettings.timerEnd;
    if(category==='taskApproaching') return notificationSettings.taskApproaching;
    if(category==='studyStart') return notificationSettings.studyStart;
    if(category==='taskComment') return notificationSettings.taskComment;
    if(category==='groupChanges') return notificationSettings.groupChanges;
    return true;
  }
  async function showLocalSystemNotification(title, body, category){
    if(!notificationCategoryEnabled(category)) return;
    try{
      if(!('Notification' in window) || Notification.permission!=='granted') return;
      if(swRegistration){
        await swRegistration.showNotification(title, {body, icon:'./icons/icon-192.png', badge:'./icons/icon-192.png', data:{url:'./index.html'}, vibrate:[100,50,100]});
      } else {
        new Notification(title, {body});
      }
    }catch(e){ console.warn('local notification failed',e); }
  }
  function scheduleLocalTaskAlerts(){
    if(window.__taskAlertHandle) clearInterval(window.__taskAlertHandle);
    const check=()=>{
      if(!me || !notificationSettings.taskApproaching) return;
      const now=Date.now();
      const dateKey=fmtDate(new Date());
      const tasks=blocksForDateIn(state,new Date());
      tasks.forEach(t=>{
        if(!t.start) return;
        const parts=String(t.start).split(':').map(Number);
        if(parts.length<2 || !Number.isFinite(parts[0]) || !Number.isFinite(parts[1])) return;
        const due=new Date(); due.setHours(parts[0],parts[1],0,0);
        const diff=due.getTime()-now;
        if(diff>=4*60*1000 && diff<=6*60*1000){
          const key='sb-task-alert:'+dateKey+':'+t.id;
          if(localStorage.getItem(key)) return;
          localStorage.setItem(key,'1');
          const label=t.label||subjectNameIn(t.subject,state);
          pushNotification(me.id, `Task starting in 5 minutes: ${label}`, 'taskApproaching');
          showLocalSystemNotification('Study Board', `Task starting in 5 minutes: ${label}`, 'taskApproaching');
        }
      });
    };
    check();
    window.__taskAlertHandle=setInterval(check,30000);
  }
  function armLocalTimerEndAlert(){
    if(window.__timerAlertHandle) clearTimeout(window.__timerAlertHandle);
    if(!notificationSettings.timerEnd || timerMode!=='countdown' || !timerRunning) return;
    const remaining=Math.max(0, countdownTotalMs-elapsedMs);
    if(remaining<=0) return;
    window.__timerAlertHandle=setTimeout(()=>{
      if(!timerRunning || timerMode!=='countdown') return;
      pushNotification(me.id, 'Focus timer finished 🎉', 'timerEnd');
      showLocalSystemNotification('Focus timer finished', 'Your focus timer is complete.', 'timerEnd');
    }, remaining+250);
  }
  function clearLocalTimerEndAlert(){ if(window.__timerAlertHandle){ clearTimeout(window.__timerAlertHandle); window.__timerAlertHandle=null; } }
  async function writeTimerSchedule(active){
    if(!me) return;
    try{
      await setDoc(doc(db,'timerSchedules',me.id), {
        active:!!active,
        endsAt: active && timerMode==='countdown' ? Date.now()+Math.max(0,countdownTotalMs-elapsedMs) : null,
        title: linkedTaskId ? ((blocksForDateIn(state,new Date()).find(t=>t.id===linkedTaskId)||{}).label || 'Focus timer') : 'Focus timer',
        updatedAt:Date.now()
      }, {merge:true});
    }catch(e){}
  }
  async function loadNotifications(uid){
    try{
      const snap = await getDoc(doc(db, 'notifications', uid));
      return snap.exists() ? (snap.data().items || []) : [];
    }catch(e){ return []; }
  }
  async function pushNotification(uid, text, category='taskComment', meta={}){
    if(!uid) return;
    try{
      const now=Date.now();
      const items = await loadNotifications(uid);
      items.push({ text, ts: now, read:false, category, ...meta });
      while(items.length > NOTIF_LIMIT) items.shift();
      await setDoc(doc(db, 'notifications', uid), { items });
    }catch(e){ console.error('notify failed', e); }
  }
  async function notifyOthers(text, excludeId, category='taskComment'){
    const targets = usersList.filter(u=>u.id!==(excludeId||me.id));
    for(const u of targets){ await pushNotification(u.id, text, category); }
  }
  async function notifyForComment(cid, title, text){
    const snippet = text.length>60 ? text.slice(0,57)+'…' : text;
    if(cid.startsWith('p_')){
      const ownerId = cid.split('_')[1];
      if(ownerId && ownerId!==me.id) await pushNotification(ownerId, `${me.name} commented on "${title}": ${snippet}`, 'taskComment');
    } else if(cid.startsWith('s_')){
      await notifyOthers(`${me.name} commented on "${title}": ${snippet}`, null, 'taskComment');
    }
  }
  async function refreshBellBadge(){
    if(!me) return;
    const items = await loadNotifications(me.id);
    const unread = items.filter(i=>!i.read).length;
    const badge = document.getElementById('bellBadge');
    if(!badge) return;
    if(unread>0){ badge.style.display='flex'; badge.textContent = unread>9?'9+':String(unread); }
    else { badge.style.display='none'; }
  }
  async function openNotificationsModal(){
    const items = await loadNotifications(me.id); 
    const displayItems = items.slice().reverse();
    const permState = await pushPermissionState();
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.innerHTML = `
      <div class="modal" style="max-height:75vh; display:flex; flex-direction:column;">
        <button class="close-x">×</button>
        <h3>Notifications</h3>
        ${permState==='default' ? `
          <div class="live-row" style="justify-content:space-between; margin-bottom:12px;">
            <span style="color:var(--chalk-dim);">Get alerts even when the app's closed</span>
            <button class="btn btn-primary" id="enablePushBtn" style="flex:none; padding:8px 14px;">Enable</button>
          </div>` : ''}
        ${permState==='granted' ? `
          <div class="live-row" style="justify-content:space-between; margin-bottom:6px;">
            <span style="color:var(--chalk-dim);">Push notifications</span>
            <button class="btn btn-ghost" id="enablePushBtn" style="flex:none; padding:8px 14px;">Re-check / fix</button>
          </div>` : ''}
        ${permState==='denied' ? `
          <div style="font-size:11px; color:var(--chalk-faint); margin-bottom:12px;">
            Notifications are blocked for this app in your browser/phone settings.
          </div>` : ''}
        <div style="flex:1; overflow-y:auto;">
          ${displayItems.length ? displayItems.map(n=>`
            <div class="notif-item ${n.read?'':'unread'}">
              <div>${escapeHtml(n.text)}</div>
              <div class="t">${timeAgo(n.ts)}</div>
            </div>
          `).join('') : `<div style="color:var(--chalk-faint); font-size:12px;">No notifications yet.</div>`}
        </div>
      </div>
    `;
    document.body.appendChild(backdrop);
    function close(){ document.body.removeChild(backdrop); }
    backdrop.querySelector('.close-x').addEventListener('click', close);
    backdrop.addEventListener('click', (e)=>{ if(e.target===backdrop) close(); });
    const pushBtn = backdrop.querySelector('#enablePushBtn');
    if(pushBtn){
      pushBtn.addEventListener('click', async ()=>{
        pushBtn.textContent = '…';
        const res = await enablePushNotifications();
        if(res.ok){ pushBtn.textContent = 'Enabled ✓'; pushBtn.disabled = true; }
        else if(res.reason==='not_configured'){ pushBtn.textContent = 'Not set up yet'; pushBtn.disabled = true; }
        else if(res.reason==='denied'){ pushBtn.textContent = 'Blocked in browser settings'; }
        else { pushBtn.textContent = 'Try again'; }
      });
    }
    if(items.length){
      try{ await setDoc(doc(db, 'notifications', me.id), { items: [] }); }catch(e){}
      refreshBellBadge();
    }
  }

  // ---------- v6 Live group controller ----------
  let liveGroupUsersHidden = false;
  function liveGroupHideKey(){ return activeGroupId ? 'sb-live-group-hidden:'+activeGroupId : 'sb-live-group-hidden:none'; }
  function loadLiveGroupHidden(){
    try{ liveGroupUsersHidden = localStorage.getItem(liveGroupHideKey()) === '1'; }catch(e){ liveGroupUsersHidden = false; }
  }
  function saveLiveGroupHidden(){
    try{ localStorage.setItem(liveGroupHideKey(), liveGroupUsersHidden ? '1' : '0'); }catch(e){}
  }
  function renderLiveGroupPanel(){
    const btn = document.getElementById('liveGroupBtn');
    const label = document.getElementById('liveGroupLabel');
    const icon = document.getElementById('liveGroupIcon');
    const row = document.getElementById('livePeopleRow');
    if(!btn || !label || !icon) return;
    if(!activeGroupData){
      label.textContent = 'Create or join a group';
      icon.textContent = '＋';
      btn.classList.add('minimal');
      if(row) row.style.display = '';
      return;
    }
    if(liveGroupUsersHidden){
      btn.classList.add('minimal');
      icon.textContent = '👤';
      label.textContent = me ? me.name : 'You';
      if(row) row.style.display = 'none';
    }else{
      btn.classList.remove('minimal');
      icon.textContent = '👥';
      label.textContent = activeGroupData.name || 'Group';
      if(row) row.style.display = currentScreen==='live' ? '' : 'none';
    }
  }
  function openLiveGroupMenu(){
    const backdrop=document.createElement('div'); backdrop.className='modal-backdrop';
    backdrop.innerHTML=`<div class="modal"><button class="close-x">×</button><h3>${escapeHtml(activeGroupData?.name || 'Group')}</h3><div style="font-size:11px;color:var(--chalk-faint);margin:-8px 0 12px;">Manage the active Live group.</div><div class="group-action-grid"><button class="btn btn-ghost" id="lg-edit">✎<br><small>Edit</small></button><button class="btn btn-ghost" id="lg-share">↗<br><small>Share</small></button><button class="btn btn-ghost" id="lg-hide">◉<br><small>${liveGroupUsersHidden?'Show people':'Hide people'}</small></button><button class="btn btn-primary" id="lg-switch">⇄<br><small>Switch / Create</small></button></div></div>`;
    document.body.appendChild(backdrop);
    const close=()=>backdrop.remove();
    backdrop.querySelector('.close-x').addEventListener('click',close);
    backdrop.addEventListener('click',e=>{if(e.target===backdrop)close();});
    backdrop.querySelector('#lg-edit').addEventListener('click',()=>{close(); openGroupEditModal(activeGroupId);});
    backdrop.querySelector('#lg-share').addEventListener('click',()=>{close(); openGroupShareModal(activeGroupId);});
    backdrop.querySelector('#lg-hide').addEventListener('click',()=>{liveGroupUsersHidden=!liveGroupUsersHidden; saveLiveGroupHidden(); renderLiveGroupPanel(); renderPeopleRow(); close();});
    backdrop.querySelector('#lg-switch').addEventListener('click',()=>{close(); openGroupsModal();});
  }
  async function openGroupShareModal(groupId){
    if(!groupId) return;
    let g=activeGroupData;
    try{ const snap=await getDoc(doc(db,'groups',groupId)); if(snap.exists()) g=snap.data(); }catch(e){}
    if(!g) return;
    const inviteUrl=location.origin+location.pathname+'?join='+g.inviteCode;
    const qrUrl='https://api.qrserver.com/v1/create-qr-code/?size=220x220&data='+encodeURIComponent(inviteUrl);
    const backdrop=document.createElement('div'); backdrop.className='modal-backdrop';
    backdrop.innerHTML=`<div class="modal"><button class="close-x">×</button><h3>Share ${escapeHtml(g.name)}</h3><div class="grp-detail-code"><div style="font-size:10px;color:var(--chalk-faint);text-transform:uppercase;margin-bottom:4px;">Access code</div><div class="code">${escapeHtml(g.inviteCode||'')}</div><img src="${qrUrl}" alt="QR code"><button class="btn btn-ghost" id="lg-copy" style="width:100%;margin-top:6px;">Copy invite link</button></div><div style="font-size:11px;color:var(--chalk-faint);word-break:break-all;">${escapeHtml(inviteUrl)}</div></div>`;
    document.body.appendChild(backdrop);
    const close=()=>backdrop.remove();
    backdrop.querySelector('.close-x').addEventListener('click',close);
    backdrop.querySelector('#lg-copy').addEventListener('click',()=>{navigator.clipboard?.writeText(inviteUrl).catch(()=>{}); const b=backdrop.querySelector('#lg-copy'); const old=b.textContent; b.textContent='Copied ✓'; setTimeout(()=>b.textContent=old,1200);});
  }
  async function openGroupEditModal(groupId){
    if(!groupId) return;
    let g=activeGroupData;
    try{ const snap=await getDoc(doc(db,'groups',groupId)); if(snap.exists()) g=snap.data(); }catch(e){}
    if(!g) return;
    const isOwner=g.ownerId===me.id;
    const members=Object.keys(g.members||{});
    const backdrop=document.createElement('div'); backdrop.className='modal-backdrop';
    backdrop.innerHTML=`<div class="modal"><button class="close-x">×</button><h3>Edit group</h3><div class="field-row"><label>Group name</label><input id="lge-name" type="text" value="${escapeHtml(g.name||'')}"></div><div class="field-row"><label>Daily target (hours)</label><input id="lge-daily" type="number" min="0" step="0.5" value="${Number(g.dailyGoalHours||0)}"></div><div class="field-row"><label>Weekly target (hours)</label><input id="lge-weekly" type="number" min="0" step="0.5" value="${Number(g.weeklyGoalHours||0)}"></div><div class="field-row"><label>Deadline</label><input id="lge-deadline" type="date" value="${g.deadlineAt?new Date(g.deadlineAt).toISOString().slice(0,10):''}"></div><h4 style="margin:16px 0 6px;font-family:'Kalam';font-size:14px;color:var(--chalk-dim);font-weight:400;">Members</h4><div class="group-edit-members" id="lge-members"></div><div class="modal-actions"><button class="btn btn-ghost" id="lge-cancel">Cancel</button><button class="btn btn-primary" id="lge-save">Save</button></div>${isOwner?'<button class="btn btn-danger" id="lge-delete" style="width:100%;margin-top:8px;">Delete group</button>':''}</div>`;
    document.body.appendChild(backdrop);
    const close=()=>backdrop.remove();
    backdrop.querySelector('.close-x').addEventListener('click',close);
    backdrop.querySelector('#lge-cancel').addEventListener('click',close);
    const membersWrap=backdrop.querySelector('#lge-members');
    membersWrap.innerHTML=members.map(uid=>{const p=profileFor(uid); return `<div class="group-edit-member"><span>${escapeHtml(p.name)}${uid===me.id?' (you)':''}${uid===g.ownerId?' 👑':''}</span>${isOwner&&uid!==me.id?`<button type="button" data-remove="${uid}">Remove</button>`:''}</div>`;}).join('')||'<div style="padding:10px;color:var(--chalk-faint);">No members.</div>';
    membersWrap.querySelectorAll('[data-remove]').forEach(b=>b.addEventListener('click',async()=>{await removeMemberFromGroup(groupId,b.dataset.remove); openGroupEditModal(groupId); close();}));
    backdrop.querySelector('#lge-save').addEventListener('click',async()=>{
      const name=backdrop.querySelector('#lge-name').value.trim(); if(!name){alert('Group name is required.');return;}
      const deadlineStr=backdrop.querySelector('#lge-deadline').value;
      const patch={name,dailyGoalHours:parseFloat(backdrop.querySelector('#lge-daily').value)||0,weeklyGoalHours:parseFloat(backdrop.querySelector('#lge-weekly').value)||0,deadlineAt:deadlineStr?new Date(deadlineStr+'T23:59:59').getTime():null};
      await setDoc(doc(db,'groups',groupId),patch,{merge:true}); close();
    });
    const del=backdrop.querySelector('#lge-delete');
    if(del) del.addEventListener('click',async()=>{if(!confirm('Delete this group permanently?')) return; try{await deleteDoc(doc(db,'groups',groupId)); await deleteDoc(doc(db,'groupMemberships',me.id));}catch(e){alert('Could not delete group: '+e.message);return;} myGroupIds=myGroupIds.filter(id=>id!==groupId); activeGroupId=myGroupIds[0]||null; try{await setDoc(doc(db,'groupMemberships',me.id),{groupIds:myGroupIds,activeGroupId},{merge:true});}catch(e){} close(); await subscribeActiveGroup();});
  }

  function renderGroupBar(){
    loadLiveGroupHidden();
    renderLiveGroupPanel();
  }
  document.getElementById('liveGroupBtn')?.addEventListener('click', (e)=>{ e.preventDefault(); e.stopPropagation(); openLiveGroupMenu(); });
  let sharedPeopleCollapsed = false;
  document.getElementById('peopleCollapseBtn')?.addEventListener('click', (e)=>{
    e.preventDefault(); e.stopPropagation();
    sharedPeopleCollapsed=!sharedPeopleCollapsed;
    renderPeopleRow();
  });

  function openGroupsModal(jumpToGroupId){
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.innerHTML = `<div class="modal" id="grpModalBody"></div>`;
    document.body.appendChild(backdrop);
    function close(){ document.body.removeChild(backdrop); }
    backdrop.addEventListener('click', (e)=>{ if(e.target===backdrop) close(); });

    async function drawList(){
      const body = backdrop.querySelector('#grpModalBody');
      body.innerHTML = `
        <button class="close-x">×</button>
        <h3>My Groups</h3>
        <div id="grp-list-wrap"><div style="font-size:12px; color:var(--chalk-faint);">Loading…</div></div>
        <div class="grp-actions-row">
          <button class="btn btn-ghost" id="grp-join-btn">Join with code</button>
          <button class="btn btn-primary" id="grp-create-btn">+ Create group</button>
        </div>
      `;
      body.querySelector('.close-x').addEventListener('click', close);
      const listWrap = body.querySelector('#grp-list-wrap');
      const groups = [];
      for(const gid of myGroupIds){
        try{ const snap = await getDoc(doc(db,'groups',gid)); if(snap.exists()) groups.push(snap.data()); }catch(e){}
      }
      if(!groups.length){
        listWrap.innerHTML = `<div style="font-size:12px; color:var(--chalk-faint); padding:10px 0;">You're not in any groups yet.</div>`;
      } else {
        listWrap.innerHTML = groups.map(g=>{
          const count = Object.keys(g.members||{}).length;
          const ended = g.deadlineAt && Date.now() > g.deadlineAt;
          return `
            <div class="grp-list-item ${g.id===activeGroupId?'active':''}" data-gid="${g.id}">
              <div>
                <div class="name">${escapeHtml(g.name)}</div>
                <div class="meta">${count} member${count===1?'':'s'}${ended?' · ended':''}${g.visibility==='private'?' · 🔒 private':''}</div>
              </div>
              <div style="color:var(--chalk-faint);">›</div>
            </div>
          `;
        }).join('');
        listWrap.querySelectorAll('[data-gid]').forEach(el=>{
          el.addEventListener('click', ()=> drawDetail(el.dataset.gid));
        });
      }
      body.querySelector('#grp-join-btn').addEventListener('click', drawJoin);
      body.querySelector('#grp-create-btn').addEventListener('click', drawCreate);
    }

    function drawCreate(){
      const body = backdrop.querySelector('#grpModalBody');
      body.innerHTML = `
        <button class="close-x">×</button>
        <h3>Create a group</h3>
        <div class="field-row">
          <label>Group name</label>
          <input type="text" id="gc-name" placeholder="e.g. CSAT batch">
        </div>
        <div class="field-row">
          <label>Privacy</label>
          <div class="mode-switch">
            <button type="button" class="active" id="gc-public">Public (code only)</button>
            <button type="button" id="gc-private">Private (+password)</button>
          </div>
        </div>
        <div class="field-row hidden" id="gc-pass-row">
          <label>Password (required for private groups)</label>
          <input type="text" id="gc-password" placeholder="Set a password">
        </div>
        <div class="field-row">
          <label>Deadline <span style="opacity:.6; text-transform:none;">(optional)</span></label>
          <input type="date" id="gc-deadline">
        </div>
        <div class="field-row">
          <label>Suggested daily goal (hours, 0 = off)</label>
          <input type="number" id="gc-daily" min="0" step="0.5" value="2">
        </div>
        <div class="field-row">
          <label>Suggested weekly goal (hours, 0 = off)</label>
          <input type="number" id="gc-weekly" min="0" step="0.5" value="10">
        </div>
        <div class="modal-actions">
          <button class="btn btn-ghost" id="gc-back">Back</button>
          <button class="btn btn-primary" id="gc-save">Create</button>
        </div>
      `;
      body.querySelector('.close-x').addEventListener('click', close);
      body.querySelector('#gc-back').addEventListener('click', drawList);
      let isPrivate = false;
      body.querySelector('#gc-public').addEventListener('click', ()=>{
        isPrivate=false;
        body.querySelector('#gc-public').classList.add('active');
        body.querySelector('#gc-private').classList.remove('active');
        body.querySelector('#gc-pass-row').classList.add('hidden');
      });
      body.querySelector('#gc-private').addEventListener('click', ()=>{
        isPrivate=true;
        body.querySelector('#gc-private').classList.add('active');
        body.querySelector('#gc-public').classList.remove('active');
        body.querySelector('#gc-pass-row').classList.remove('hidden');
      });
      body.querySelector('#gc-save').addEventListener('click', async ()=>{
        const name = body.querySelector('#gc-name').value.trim();
        if(!name){ alert('Give your group a name.'); return; }
        const password = body.querySelector('#gc-password').value.trim();
        if(isPrivate && !password){ alert('Private groups need a password.'); return; }
        const deadlineStr = body.querySelector('#gc-deadline').value;
        const deadlineMs = deadlineStr ? new Date(deadlineStr+'T23:59:59').getTime() : null;
        const dailyGoalHours = parseFloat(body.querySelector('#gc-daily').value)||0;
        const weeklyGoalHours = parseFloat(body.querySelector('#gc-weekly').value)||0;
        body.querySelector('#gc-save').disabled = true;
        try{
          await createGroup({ name, isPrivate, password, deadlineMs, dailyGoalHours, weeklyGoalHours });
          close();
        }catch(e){ alert('Could not create group: '+e.message); body.querySelector('#gc-save').disabled = false; }
      });
    }

    function drawJoin(){
      const body = backdrop.querySelector('#grpModalBody');
      body.innerHTML = `
        <button class="close-x">×</button>
        <h3>Join a group</h3>
        <div class="field-row">
          <label>Invite code</label>
          <input type="text" id="gj-code" placeholder="e.g. AB12CD" style="text-transform:uppercase;">
        </div>
        <div class="field-row">
          <label>Password <span style="opacity:.6; text-transform:none;">(if applicable)</span></label>
          <input type="text" id="gj-password" placeholder="Leave blank if none">
        </div>
        <div class="status" id="gj-status" style="font-size:12px; color:var(--danger); min-height:16px; margin-bottom:8px;"></div>
        <div class="modal-actions">
          <button class="btn btn-ghost" id="gj-back">Back</button>
          <button class="btn btn-primary" id="gj-save">Join</button>
        </div>
      `;
      body.querySelector('.close-x').addEventListener('click', close);
      body.querySelector('#gj-back').addEventListener('click', drawList);
      body.querySelector('#gj-save').addEventListener('click', async ()=>{
        const code = body.querySelector('#gj-code').value;
        const password = body.querySelector('#gj-password').value;
        const statusEl = body.querySelector('#gj-status');
        statusEl.textContent = '';
        body.querySelector('#gj-save').disabled = true;
        try{
          const g = await joinGroupByCode(code, password);
          statusEl.style.color = 'var(--ok)';
          statusEl.textContent = `Joined ${g.name}!`;
          setTimeout(close, 700);
        }catch(e){
          statusEl.style.color = 'var(--danger)';
          statusEl.textContent = e.message;
          body.querySelector('#gj-save').disabled = false;
        }
      });
    }

    async function drawDetail(groupId){
      const body = backdrop.querySelector('#grpModalBody');
      body.innerHTML = `<button class="close-x">×</button><div style="font-size:12px; color:var(--chalk-faint);">Loading…</div>`;
      body.querySelector('.close-x').addEventListener('click', close);
      let g;
      try{ const snap = await getDoc(doc(db,'groups',groupId)); g = snap.exists() ? snap.data() : null; }catch(e){}
      if(!g){ body.innerHTML = `<button class="close-x">×</button><h3>Group not found</h3>`; body.querySelector('.close-x').addEventListener('click', close); return; }
      const isOwner = g.ownerId===me.id;
      const isActive = g.id===activeGroupId;
      const memberIds = Object.keys(g.members||{});
      const inviteUrl = location.origin + location.pathname + '?join=' + g.inviteCode;
      const qrUrl = 'https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=' + encodeURIComponent(inviteUrl);
      const ended = g.deadlineAt && Date.now() > g.deadlineAt;
      const myHide = (g.members[me.id]||{}).hideSchedule || false;

      body.innerHTML = `
        <button class="close-x">×</button>
        <h3>${escapeHtml(g.name)}</h3>
        <div style="font-size:11px; color:var(--chalk-faint); margin-bottom:10px;">
          ${g.visibility==='private' ? '🔒 Private' : '🌐 Public'} · ${memberIds.length} member${memberIds.length===1?'':'s'}
          ${g.deadlineAt ? ` · ${ended?'ended':'ends'} ${new Date(g.deadlineAt).toLocaleDateString()}` : ''}
        </div>

        ${!isActive ? `<button class="btn btn-primary" id="gd-switch" style="width:100%; margin-bottom:10px;">Switch to this group</button>` : `<div style="text-align:center; color:var(--accent); font-size:12px; margin-bottom:10px;">✓ Currently active</div>`}

        <div class="grp-detail-code">
          <div style="font-size:10px; color:var(--chalk-faint); text-transform:uppercase; margin-bottom:4px;">Invite code</div>
          <div class="code">${g.inviteCode}</div>
          <img src="${qrUrl}" alt="QR code">
          <button class="btn btn-ghost" id="gd-copy" style="width:100%; margin-top:6px;">Copy invite link</button>
        </div>

        <div class="grp-toggle-row">
          <span>Hide my schedule from this group</span>
          <label class="switch"><input type="checkbox" id="gd-hide" ${myHide?'checked':''}><span class="slider"></span></label>
        </div>

        ${isOwner && g.deadlineAt ? `<button class="btn btn-ghost" id="gd-extend" style="width:100%; margin:6px 0;">Extend deadline</button>` : ''}

        <h4 style="margin:16px 0 6px; font-family:'Kalam'; font-size:14px; color:var(--chalk-dim); font-weight:400;">Members</h4>
        <div id="gd-members"></div>

        <div class="modal-actions">
          <button class="btn btn-ghost" id="gd-back">Back</button>
          <button class="btn btn-danger" id="gd-leave">Leave group</button>
        </div>
      `;
      body.querySelector('#gd-members').innerHTML = memberIds.map(uid=>{
        const p = profileFor(uid);
        return `
          <div class="grp-member-row">
            <span><span class="dot" style="background:${p.color}"></span>${escapeHtml(p.name)}${uid===me.id?' (you)':''}${uid===g.ownerId?' 👑':''}</span>
            ${isOwner && uid!==me.id ? `<button class="task-del" data-remove="${uid}">×</button>` : ''}
          </div>
        `;
      }).join('');
      body.querySelector('#gd-members').querySelectorAll('[data-remove]').forEach(btn=>{
        btn.addEventListener('click', async ()=>{
          await removeMemberFromGroup(groupId, btn.dataset.remove);
          drawDetail(groupId);
        });
      });
      const switchBtn = body.querySelector('#gd-switch');
      if(switchBtn) switchBtn.addEventListener('click', async ()=>{ await setActiveGroup(groupId); close(); });
      body.querySelector('#gd-copy').addEventListener('click', ()=>{
        navigator.clipboard?.writeText(inviteUrl).catch(()=>{});
        const btn = body.querySelector('#gd-copy'); const old = btn.textContent;
        btn.textContent = 'Copied!'; setTimeout(()=> btn.textContent = old, 1200);
      });
      body.querySelector('#gd-hide').addEventListener('change', (e)=>{ setMyHideSchedule(groupId, e.target.checked); });
      const extendBtn = body.querySelector('#gd-extend');
      if(extendBtn) extendBtn.addEventListener('click', async ()=>{
        const newDate = prompt('New deadline (YYYY-MM-DD):', new Date(g.deadlineAt).toISOString().slice(0,10));
        if(!newDate) return;
        const ms = new Date(newDate+'T23:59:59').getTime();
        if(isNaN(ms)) return;
        await extendGroupDeadline(groupId, ms);
        drawDetail(groupId);
      });
      body.querySelector('#gd-back').addEventListener('click', drawList);
      const leaveBtn = body.querySelector('#gd-leave');
      if(leaveBtn) leaveBtn.addEventListener('click', async ()=>{
        await leaveGroup(groupId);
        drawList();
      });
    }

    if(jumpToGroupId){ drawDetail(jumpToGroupId); } else { drawList(); }
  }

  onAuthStateChanged(auth, async (user)=>{
    if(user && !booted){
      booted = true;
      window.__meId = user.uid;
      try{
        const res = await window.storage.get('study-board-profile', false);
        me = res && res.value ? JSON.parse(res.value) : { id: user.uid, name: 'Student', color: COLORS[0] };
      }catch(e){ me = { id: user.uid, name: 'Student', color: COLORS[0] }; }
      showApp();
      await loadState();
    } else if(!user){
      booted = false;
      me = null;
      window.__meId = null;
      showAuth();
    }
  });
  async function loadUsersList(){
    try{
      const res = await window.storage.get(USERS_KEY, true);
      allProfiles = res && res.value ? JSON.parse(res.value) : [];
    }catch(e){ allProfiles = []; }
  }
  async function registerUser(user, forceUpdate){
    let list = [];
    try{
      const res = await window.storage.get(USERS_KEY, true);
      list = res && res.value ? JSON.parse(res.value) : [];
    }catch(e){ list = []; }
    const idx = list.findIndex(u=>u.id===user.id);
    const entry = {id:user.id, name:user.name, color:user.color, photo:user.photo||null};
    if(idx===-1){ list.push(entry); try{ await window.storage.set(USERS_KEY, JSON.stringify(list), true); }catch(e){} }
    else if(forceUpdate){ list[idx] = entry; try{ await window.storage.set(USERS_KEY, JSON.stringify(list), true); }catch(e){} }
    allProfiles = list;
    deriveUsersList();
  }

  // ---------- groups engine ----------
  function genCode(len){
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; 
    let s=''; for(let i=0;i<len;i++) s += chars[Math.floor(Math.random()*chars.length)];
    return s;
  }
  function profileFor(id){
    const p = allProfiles.find(u=>u.id===id);
    if(p) return p;
    if(me && id===me.id) return { id, name: me.name, color: me.color, photo: me.photo };
    return { id, name: 'Member', color: '#7FB3D5', photo: null };
  }
  function deriveUsersList(){
    if(!me){ usersList = []; return; }
    const memberIds = (activeGroupData && activeGroupData.members) ? Object.keys(activeGroupData.members) : [me.id];
    usersList = memberIds.map(profileFor);
    if(!usersList.find(u=>u.id===me.id)) usersList.unshift(profileFor(me.id));
  }
  async function loadMyGroupIds(){
    try{
      const snap = await getDoc(doc(db, 'groupMemberships', me.id));
      if(snap.exists()){
        myGroupIds = snap.data().groupIds || [];
        activeGroupId = snap.data().activeGroupId || myGroupIds[0] || null;
        return true; 
      }
    }catch(e){}
    return false;
  }
  async function subscribeActiveGroup(){
    if(groupUnsub){ groupUnsub(); groupUnsub = null; }
    if(!activeGroupId){ activeGroupData = null; deriveUsersList(); renderGroupBar(); renderPeopleRow(); renderSnapRow(); return; }
    groupUnsub = onSnapshot(doc(db, 'groups', activeGroupId), (snap)=>{
      activeGroupData = snap.exists() ? snap.data() : null;
      deriveUsersList();
      renderGroupBar();
      renderPeopleRow();
      renderSnapRow();
    }, (err)=> console.warn('group sync error', err));
  }
  async function setActiveGroup(groupId){
    activeGroupId = groupId;
    try{ await setDoc(doc(db,'groupMemberships', me.id), { activeGroupId: groupId }, { merge:true }); }catch(e){}
    viewingId = null;
    await subscribeActiveGroup();
  }
  async function createGroup({ name, isPrivate, password, deadlineMs, dailyGoalHours, weeklyGoalHours }){
    const groupId = 'grp_'+Date.now()+'_'+Math.random().toString(36).slice(2,7);
    const inviteCode = genCode(6);
    const groupDoc = {
      id: groupId, name: name || 'Untitled group', ownerId: me.id,
      members: { [me.id]: { joinedAt: Date.now(), hideSchedule:false } },
      visibility: isPrivate ? 'private' : 'public',
      password: isPrivate && password ? password : null,
      inviteCode,
      deadlineAt: deadlineMs || null,
      dailyGoalHours: dailyGoalHours || 0,
      weeklyGoalHours: weeklyGoalHours || 0,
      createdAt: Date.now()
    };
    await setDoc(doc(db,'groups',groupId), groupDoc);
    await setDoc(doc(db,'groupInvites',inviteCode), { groupId });
    if(!myGroupIds.includes(groupId)) myGroupIds.push(groupId);
    await setDoc(doc(db,'groupMemberships', me.id), { groupIds: myGroupIds, activeGroupId: groupId }, { merge:true });
    await setActiveGroup(groupId);
    return groupDoc;
  }
  async function joinGroupByCode(codeRaw, passwordAttempt){
    const code = (codeRaw||'').trim().toUpperCase();
    if(!code) throw new Error('Enter an invite code.');
    const invSnap = await getDoc(doc(db,'groupInvites', code));
    if(!invSnap.exists()) throw new Error('That invite code doesn\'t match any group.');
    const groupId = invSnap.data().groupId;
    const gSnap = await getDoc(doc(db,'groups',groupId));
    if(!gSnap.exists()) throw new Error('This group no longer exists.');
    const g = gSnap.data();
    if(g.password && g.password !== (passwordAttempt||'')) throw new Error('Wrong password for this group.');
    await setDoc(doc(db,'groups',groupId), { members: { [me.id]: { joinedAt: Date.now(), hideSchedule:false } } }, { merge:true });
    if(!myGroupIds.includes(groupId)) myGroupIds.push(groupId);
    await setDoc(doc(db,'groupMemberships', me.id), { groupIds: myGroupIds, activeGroupId: groupId }, { merge:true });
    await setActiveGroup(groupId);
    const existingMemberIds = Object.keys(g.members||{}).filter(id=>id!==me.id);
    for(const id of existingMemberIds){ await pushNotification(id, `${me.name} joined "${g.name}"`, 'groupChanges'); }
    return g;
  }
  async function leaveGroup(groupId){
    try{
      const snap = await getDoc(doc(db,'groups',groupId));
      const g = snap.exists() ? snap.data() : null;
      if(g){ for(const uid of Object.keys(g.members||{})){ if(uid!==me.id) await pushNotification(uid, `${me.name} left "${g.name}"`, 'groupChanges'); } }
    }catch(e){}
    try{ await setDoc(doc(db,'groups',groupId), { members: { [me.id]: deleteField() } }, { merge:true }); }catch(e){}
    myGroupIds = myGroupIds.filter(id=>id!==groupId);
    const nextActive = activeGroupId===groupId ? (myGroupIds[0] || null) : activeGroupId;
    await setDoc(doc(db,'groupMemberships', me.id), { groupIds: myGroupIds, activeGroupId: nextActive }, { merge:true });
    await setActiveGroup(nextActive);
  }
  async function removeMemberFromGroup(groupId, uid){
    try{
      const snap=await getDoc(doc(db,'groups',groupId));
      const g=snap.exists()?snap.data():null;
      if(g){ const p=profileFor(uid); for(const memberId of Object.keys(g.members||{})){ if(memberId!==uid) await pushNotification(memberId, `${p.name} left "${g.name}"`, 'groupChanges'); } }
    }catch(e){}
    try{ await setDoc(doc(db,'groups',groupId), { members: { [uid]: deleteField() } }, { merge:true }); }catch(e){}
  }
  async function extendGroupDeadline(groupId, newDeadlineMs){
    await setDoc(doc(db,'groups',groupId), { deadlineAt: newDeadlineMs }, { merge:true });
  }
  async function setMyHideSchedule(groupId, hide){
    try{ await setDoc(doc(db,'groups',groupId), { members: { [me.id]: { hideSchedule: hide } } }, { merge:true }); }catch(e){}
  }

  function pushSharedBoard(){
    if(!me) return;
    const shared = { subjects: state.subjects, weeklyTemplate: state.weeklyTemplate, weeklyGoals: state.weeklyGoals, dailyExtra: state.dailyExtra, completion: state.completion, sessions: state.sessions, goals: state.goals };
    window.storage.set('board:'+me.id, JSON.stringify(shared), true).catch(e=>console.error('share failed', e));
  }
  async function fetchFriendBoard(id){
    try{
      const res = await window.storage.get('board:'+id, true);
      friendCache[id] = res && res.value ? JSON.parse(res.value) : {subjects:[],weeklyTemplate:[],weeklyGoals:[],dailyExtra:{},completion:{},sessions:{}};
    }catch(e){
      friendCache[id] = {subjects:[],weeklyTemplate:[],weeklyGoals:[],dailyExtra:{},completion:{},sessions:{}};
    }
  }

  function renderPeopleRow(){
    const shared = document.getElementById('peopleRow');
    const live = document.getElementById('livePeopleRow');
    const renderInto = (el, visible)=>{
      if(!el) return;
      if(!visible || !me){ el.innerHTML=''; el.style.display='none'; return; }
      el.style.display=''; 
      const others = usersList.filter(u=>u.id!==me.id);
      const chips = [{id:me.id, name:'You', color:me.color, photo:me.photo}, ...others.map(u=>({id:u.id, name:u.name, color:u.color, photo:u.photo}))];
      el.innerHTML = chips.map(c=>{
        const st = liveCache[c.id];
        const studying = !!(st && st.studying);
        const mins = liveMinutesFor(st);
        const streak = c.id===me.id ? computeStreak() : computeStreakFor(friendCache[c.id] || {});
        const avatarInner = c.photo ? `<img src="${c.photo}" alt="">` : c.name.slice(0,1).toUpperCase();
        return `<div class="person-chip ${ (c.id===me.id && isViewingSelf()) || (c.id===viewingId) ? 'active':''} ${studying?'studying':''}" data-id="${c.id}"><span class="avatar" style="background:${c.color}">${avatarInner}</span><span class="p-meta"><span>${escapeHtml(c.name)}${streak>0 ? ` <span class="p-streak">🔥${streak}</span>` : ''}</span><span class="p-today">${fmtHM(mins)} today</span></span></div>`;
      }).join('');
      el.querySelectorAll('.person-chip').forEach(chip=>chip.addEventListener('click', async ()=>{
        const id=chip.dataset.id;
        if(id===me.id){ viewingId=null; render(); return; }
        viewingId=id; await fetchFriendBoard(id); render();
      }));
    };
    renderInto(shared, currentScreen!=='live');
    renderInto(live, currentScreen==='live' && !liveGroupUsersHidden);
    const wrap=document.getElementById('sharedPeopleWrap');
    if(wrap){
      wrap.classList.toggle('collapsed', sharedPeopleCollapsed && currentScreen!=='live');
      const b=document.getElementById('peopleCollapseBtn');
      if(b) b.title = sharedPeopleCollapsed ? 'Show who\'s here' : 'Collapse';
    }
  }

  function renderSnapRow(){
    const el = document.getElementById('snapRow');
    if(!el || !me) return;
    if(currentScreen!=='live'){ el.style.display = 'none'; return; }
    el.style.display = '';
    const others = usersList.filter(u=>u.id!==me.id);
    const people = [{id:me.id, name:'You', mine:true}, ...others.map(u=>({id:u.id, name:u.name, mine:false}))];
    el.innerHTML = people.map(p=>{
      const st = liveCache[p.id];
      const studying = !!(st && st.studying);
      const stale = isSnapshotStale(st);
      const streak = p.mine ? computeStreak() : computeStreakFor(friendCache[p.id] || {});
      const circleClass = ['snap-circle', p.mine?'clickable':'clickable', studying && !stale ? 'pulsing':'', stale?'stale':''].filter(Boolean).join(' ');
      const inner = (st && st.snapshot) ? `<img src="${st.snapshot}" alt="">` : p.name.slice(0,1).toUpperCase();
      let subText;
      if(p.mine){
        subText = !snapSettings.enabled ? 'snapshots off' : (camPausedManually ? 'paused' : (studying ? 'live' : 'off · not studying'));
      } else {
        subText = studying ? (stale ? 'reconnecting…' : 'live') : (stale ? `seen ${timeAgoShort(st.snapshotAt)}` : 'not studying');
      }
      const muteBadge = p.mine ? `<div class="snap-mute-badge" id="snapMuteBadge" title="Pause my snapshots">${(camPausedManually||!snapSettings.enabled)?'🚫':'📷'}</div>` : '';
      return `
        <div class="snap-tile">
          <div class="snap-circle-wrap">
            <div class="${circleClass}" data-id="${p.id}" data-mine="${p.mine?'1':'0'}">${inner}</div>
            ${muteBadge}
          </div>
          <div class="snap-name">${escapeHtml(p.name)}</div>
          ${streak>0 ? `<div class="snap-streak">🔥${streak}</div>` : ''}
          <div class="snap-sub">${subText}</div>
        </div>
      `;
    }).join('');
    const muteBadgeEl = document.getElementById('snapMuteBadge');
    if(muteBadgeEl){
      muteBadgeEl.addEventListener('click', (e)=>{
        e.stopPropagation();
        camPausedManually = !camPausedManually;
        if(camPausedManually) stopSnapshotScheduler(); else startSnapshotScheduler();
        renderSnapRow();
      });
    }
    el.querySelectorAll('.snap-circle[data-mine="0"]').forEach(circle=>{
      circle.addEventListener('click', ()=> sendNudge(circle.dataset.id));
    });
  }

  function fmtDate(d){
    return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
  }
  function pad(n){ return String(n).padStart(2,'0'); }
  function fmtHM(totalMinutes){
    const m = Math.max(0, Math.round(totalMinutes||0));
    const h = Math.floor(m/60), mm = m%60;
    return h>0 ? `${h}h ${mm}m` : `${mm}m`;
  }
  function fmtHMCompact(totalMinutes){
    const m = Math.max(0, Math.round(totalMinutes||0));
    if(m < 60) return m+'m';
    const h = Math.round((m/60)*10)/10;
    return h+'h';
  }
  function formatClock(ts){
    if(!ts) return '';
    const d = new Date(ts);
    let h = d.getHours(); const m = d.getMinutes();
    const ampm = h>=12 ? 'PM':'AM';
    h = h%12; if(h===0) h=12;
    return `${h}:${pad(m)} ${ampm}`;
  }
  function fmt12(hhmm){
    if(!hhmm || hhmm.indexOf(':')===-1) return hhmm || '';
    const [hStr,mStr] = hhmm.split(':');
    let h = parseInt(hStr,10), m = parseInt(mStr,10);
    if(isNaN(h)||isNaN(m)) return hhmm;
    const ampm = h>=12 ? 'PM':'AM';
    h = h%12; if(h===0) h=12;
    return `${h}:${pad(m)} ${ampm}`;
  }
  function addMinutesToHHMM(hhmm, minutes){
    if(!hhmm || hhmm.indexOf(':')===-1) return hhmm || '';
    let [h,m] = hhmm.split(':').map(Number);
    let total = h*60 + m + (minutes||0);
    total = ((total % 1440) + 1440) % 1440; 
    return `${pad(Math.floor(total/60))}:${pad(total%60)}`;
  }
  function timeRangeLabel(start, duration){
    if(!start) return '';
    const end = addMinutesToHHMM(start, duration||30);
    return `${fmt12(start)} – ${fmt12(end)}`;
  }
  function timeColHtml(start, duration){
    if(!start) return '';
    const end = addMinutesToHHMM(start, duration||30);
    return `${fmt12(start)}<div class="end"><span class="arrow">↓</span> ${fmt12(end)}</div>`;
  }
  function timeAgo(ts){
    const s = Math.floor((Date.now()-ts)/1000);
    if(s<60) return 'just now';
    const m = Math.floor(s/60); if(m<60) return m+'m ago';
    const h = Math.floor(m/60); if(h<24) return h+'h ago';
    const d = Math.floor(h/24); return d+'d ago';
  }
  function subjectColor(id){
    const s = activeData().subjects.find(x=>x.id===id);
    return s ? s.color : '#7FB3D5';
  }
  function subjectName(id){
    const s = activeData().subjects.find(x=>x.id===id);
    return s ? s.name : 'General';
  }
  function subjectColorIn(id, data){
    const s = (data.subjects||[]).find(x=>x.id===id);
    return s ? s.color : '#7FB3D5';
  }
  function subjectNameIn(id, data){
    const s = (data.subjects||[]).find(x=>x.id===id);
    return s ? s.name : 'General';
  }

  function getWeekStartDay(){ return Number.isInteger(state.weekStartDay) ? state.weekStartDay : 0; }
  function parseDateKey(key){
    const [y,m,d]=String(key||'').split('-').map(Number);
    return (y&&m&&d) ? new Date(y,m-1,d) : new Date();
  }
  function weekStartKeyWithStart(date,startDay){
    const d=new Date(date); d.setHours(0,0,0,0);
    const diff=(d.getDay()-startDay+7)%7; d.setDate(d.getDate()-diff);
    return fmtDate(d);
  }
  function migrateWeekStartSetting(oldStart,newStart){
    if(oldStart===newStart) return;
    (state.weeklyTemplate||[]).forEach(b=>{
      if(!b.weekStart) return;
      const oldWeek=parseDateKey(b.weekStart);
      const offset=(Number(b.day||0)-oldStart+7)%7;
      const actual=new Date(oldWeek); actual.setDate(actual.getDate()+offset);
      b.weekStart=weekStartKeyWithStart(actual,newStart);
    });
    (state.weeklyGoals||[]).forEach(g=>{
      if(g.weekStart) g.weekStart=weekStartKeyWithStart(parseDateKey(g.weekStart),newStart);
    });
  }
  function weekStartKey(date){
    const d = new Date(date);
    d.setHours(0,0,0,0);
    const start = getWeekStartDay();
    const diff = (d.getDay() - start + 7) % 7;
    d.setDate(d.getDate() - diff);
    return fmtDate(d);
  }
  function blocksForDate(date){
    const data = activeData();
    const key = fmtDate(date);
    const dow = date.getDay();
    const wk = weekStartKey(date);
    const templ = data.weeklyTemplate.filter(b=>b.day===dow && b.weekStart===wk).map(b=>({...b, source:'template'}));
    const extra = (data.dailyExtra[key]||[]).map(b=>({...b, source:'extra'}));
    return [...templ, ...extra].sort((a,b)=> (a.start||'').localeCompare(b.start||''));
  }
  function blocksForDateIn(data, date){
    const key = fmtDate(date);
    const dow = date.getDay();
    const wk = weekStartKey(date);
    const templ = (data.weeklyTemplate||[]).filter(b=>b.day===dow && b.weekStart===wk).map(b=>({...b, source:'template'}));
    const extra = ((data.dailyExtra||{})[key]||[]).map(b=>({...b, source:'extra'}));
    return [...templ, ...extra].sort((a,b)=> (a.start||'').localeCompare(b.start||''));
  }

  function sharedTasksKey(dateKey){ return 'shared-tasks:'+dateKey; }
  async function loadSharedTasks(dateKey){
    try{
      const res = await window.storage.get(sharedTasksKey(dateKey), true);
      return res && res.value ? JSON.parse(res.value) : [];
    }catch(e){ return []; }
  }
  async function saveSharedTasks(dateKey, list){
    try{ await window.storage.set(sharedTasksKey(dateKey), JSON.stringify(list), true); }
    catch(e){ console.error('shared task save failed', e); }
  }
  function nextStatus(cur){
    return cur==='done' ? 'missed' : (cur==='missed' ? undefined : 'done');
  }

  document.querySelectorAll('.tab-btn').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      document.querySelectorAll('.tab-btn').forEach(b=>b.classList.remove('active'));
      btn.classList.add('active');
      document.querySelectorAll('.screen').forEach(s=>s.classList.remove('active'));
      currentScreen = btn.dataset.screen;
      document.getElementById('screen-'+currentScreen).classList.add('active');
      if(currentScreen==='history' && !document.getElementById('historyDate').value){
        document.getElementById('historyDate').value = fmtDate(new Date());
      }
      const titles = {timer:['Now','stay on the clock'], today:['Today','today\'s blocks'], week:['This Week','the macro view'], live:['Live','who\'s studying right now'], history:['Analyse','look back and track your hours']};
      document.getElementById('headerTitle').textContent = titles[currentScreen][0];
      document.getElementById('headerSub').textContent = titles[currentScreen][1];
      render();
      renderLiveGroupPanel();
      renderPeopleRow();
    });
  });
  document.getElementById('fabAdd').style.display = 'none';

  let timerMode = 'stopwatch'; 
  let timerRunning = false;
  let elapsedMs = 0;
  let countdownTotalMs = 60*60*1000;
  let linkedTaskId = null;
  let customFocusMin = 60;
  let tickHandle = null;
  let lastTick = null;

  function applyModeUI(mode){
    timerMode = mode;
    document.getElementById('modeStopwatch').classList.toggle('active', mode==='stopwatch');
    document.getElementById('modeCountdown').classList.toggle('active', mode==='countdown');
    const chips=document.getElementById('countdownLenChips');
    if(chips) chips.style.display = mode==='countdown' && !timerRunning && elapsedMs===0 ? 'flex' : 'none';
    if(mode!=='countdown') document.getElementById('customFocusWheel').style.display='none';
    document.getElementById('ringOuter').style.display = mode==='countdown' ? 'block' : 'none';
    document.getElementById('stopwatchFace').style.display = mode==='countdown' ? 'none' : 'flex';
    updateRunningDeclutter();
  }

  function updateRunningDeclutter(){
    const committed = timerRunning || elapsedMs > 0;
    const modeSwitch=document.getElementById('timerModeSwitch');
    const optionsRow=document.getElementById('timerOptionsRow');
    const chips=document.getElementById('countdownLenChips');
    if(modeSwitch) modeSwitch.classList.toggle('mode-collapsed', committed);
    if(optionsRow) optionsRow.classList.remove('mode-collapsed');
    if(chips) chips.style.display = (!committed && timerMode==='countdown') ? 'flex' : 'none';
    const customWheel=document.getElementById('customFocusWheel');
    if(customWheel){
      customWheel.style.display = (!committed && timerMode==='countdown' && customWheel.innerHTML) ? 'block' : 'none';
    }
  }
  document.getElementById('modeStopwatch').addEventListener('click', ()=>{
    if(timerRunning) return; applyModeUI('stopwatch'); elapsedMs=0; renderTimerDigits();
  });
  document.getElementById('modeCountdown').addEventListener('click', ()=>{
    if(timerRunning) return; applyModeUI('countdown'); elapsedMs=0; renderTimerDigits(); updateRunningDeclutter();
  });
  document.getElementById('countdownLenChips').querySelectorAll('.dur-chip').forEach(chip=>{
    chip.addEventListener('click', ()=>{
      if(timerRunning) return;
      document.querySelectorAll('#countdownLenChips .dur-chip').forEach(c=>c.classList.remove('sel'));
      chip.classList.add('sel');
      if(chip.dataset.custom){
        document.getElementById('customFocusWheel').style.display='block';
        if(!window.__customFocusWheel) window.__customFocusWheel=createFocusDurationWheel(document.getElementById('customFocusWheel'), customFocusMin);
        countdownTotalMs=customFocusMin*60000;
      }else{
        document.getElementById('customFocusWheel').style.display='none';
        countdownTotalMs=parseInt(chip.dataset.min,10)*60000;
      }
      renderTimerDigits();
    });
  });
  document.getElementById('timerTaskPin').addEventListener('click', openTimerTaskPicker);
  document.getElementById('liveMiniStart').addEventListener('click', ()=> document.getElementById('startBtn').click());
  document.getElementById('liveMiniReset').addEventListener('click', ()=> document.getElementById('resetBtn').click());

  function createFocusDurationWheel(container, initialMin){
    const total = Math.max(1, Math.min(24*60, Number(initialMin)||60));
    const ih = Math.floor(total/60), im = total%60;
    container.innerHTML = `<div class="wheel-picker"><div class="wheel-col" id="focus-h"></div><div class="wheel-col" id="focus-m"></div><div class="wheel-highlight"></div></div><div class="wheel-label" style="display:flex;gap:2px;"><span style="flex:1">Hour</span><span style="flex:1">Minute</span></div>`;
    const hours=Array.from({length:25},(_,i)=>i), mins=Array.from({length:60},(_,i)=>pad(i));
    let hVal=ih,mVal=im;
    buildWheelColumn(container.querySelector('#focus-h'), hours, ih, v=>{hVal=Number(v); customFocusMin=Math.max(1,hVal*60+mVal); countdownTotalMs=customFocusMin*60000; renderTimerDigits();});
    buildWheelColumn(container.querySelector('#focus-m'), mins, im, v=>{mVal=Number(v); customFocusMin=Math.max(1,hVal*60+mVal); countdownTotalMs=customFocusMin*60000; renderTimerDigits();});
    return {getValue:()=>Math.max(1,hVal*60+mVal)};
  }
  function renderTimerTaskLink(){
    const label=document.getElementById('timerTaskLinkLabel'), btn=document.getElementById('timerTaskPin');
    if(!label||!btn) return;
    const task=blocksForDateIn(state,new Date()).find(b=>b.id===linkedTaskId);
    if(task){
      label.textContent=`${task.label || subjectNameIn(task.subject,state)} · ${task.duration||30} min`;
      btn.title=`Linked to: ${task.label || subjectNameIn(task.subject,state)} (${task.duration||30} min)`;
    }else{
      label.textContent='Not linked';
      btn.title='Link this timer to a daily task';
    }
    btn.classList.toggle('linked',!!task);
    if(task && timerMode==='countdown' && !timerRunning && elapsedMs===0){
      countdownTotalMs=Math.max(1,Number(task.duration||30))*60000;
      customFocusMin=Math.max(1,Number(task.duration||30));
      document.querySelectorAll('#countdownLenChips .dur-chip').forEach(c=>c.classList.remove('sel'));
      document.getElementById('customFocusWheel').style.display='none';
      renderTimerDigits();
    }
  }
  function openTimerTaskPicker(){
    if(!isViewingSelf()) return;
    const today=new Date(), tasks=blocksForDateIn(state,today);
    const backdrop=document.createElement('div'); backdrop.className='modal-backdrop';
    backdrop.innerHTML=`<div class="modal"><button class="close-x">×</button><h3>Link to today’s task</h3><div style="font-size:11px;color:var(--chalk-faint);margin:-8px 0 14px;">Optional — time logged here will update the task automatically.</div><div id="timer-task-options"></div><div class="modal-actions"><button class="btn btn-ghost" id="timer-task-skip">Skip / unlink</button></div></div>`;
    document.body.appendChild(backdrop); const wrap=backdrop.querySelector('#timer-task-options');
    wrap.innerHTML=tasks.length ? tasks.map(t=>`<button type="button" class="btn btn-ghost timer-task-option" data-id="${t.id}" style="width:100%;margin-bottom:8px;text-align:left;">${escapeHtml(t.label||subjectNameIn(t.subject,state))}<span style="float:right;color:var(--chalk-faint);">${t.duration||30} min</span></button>`).join('') : `<div class="empty" style="padding:20px 0;">No tasks scheduled for today.</div>`;
    function close(){backdrop.remove();}
    backdrop.querySelector('.close-x').addEventListener('click',close); backdrop.addEventListener('click',e=>{if(e.target===backdrop)close();});
    backdrop.querySelector('#timer-task-skip').addEventListener('click',()=>{linkedTaskId=null;renderTimerTaskLink();close();});
    wrap.querySelectorAll('.timer-task-option').forEach(b=>b.addEventListener('click',()=>{
      linkedTaskId=b.dataset.id;
      const task=tasks.find(t=>t.id===linkedTaskId);
      if(task && timerMode==='countdown' && !timerRunning && elapsedMs===0){
        countdownTotalMs=Math.max(1,Number(task.duration||30))*60000;
        customFocusMin=Math.max(1,Number(task.duration||30));
        document.querySelectorAll('#countdownLenChips .dur-chip').forEach(c=>c.classList.remove('sel'));
        document.getElementById('customFocusWheel').style.display='none';
      }
      renderTimerTaskLink(); close();
    }));
  }

  const RING_R = 100;
  const RING_C = 2 * Math.PI * RING_R;
  document.getElementById('ringProgress').style.strokeDasharray = RING_C;

  function renderTimerDigits(){
    let ms;
    if(timerMode==='countdown'){
      ms = Math.max(0, countdownTotalMs - elapsedMs);
    } else {
      ms = elapsedMs;
    }
    const totalSec = Math.floor(ms/1000);
    const h = Math.floor(totalSec/3600);
    const m = Math.floor((totalSec%3600)/60);
    const s = totalSec%60;
    const mini = document.getElementById('liveMiniDigits');
    if(timerMode==='countdown'){
      document.getElementById('timerDigits').textContent = `${pad(h)}:${pad(m)}:${pad(s)}`;
      renderRing();
      if(mini) mini.textContent = `${pad(h)}:${pad(m)}:${pad(s)}`;
    } else {
      document.getElementById('swMain').textContent = `${pad(h)}:${pad(m)}`;
      document.getElementById('swSec').textContent = `:${pad(s)}`;
      document.getElementById('stopwatchFace').classList.toggle('running', timerRunning);
      if(mini) mini.textContent = `${pad(h)}:${pad(m)}:${pad(s)}`;
    }
    const miniStart = document.getElementById('liveMiniStart');
    if(miniStart) miniStart.textContent = document.getElementById('startBtn').textContent;
  }
  function setStatusText(txt){
    document.getElementById('timerStatus').textContent = txt;
    document.getElementById('swStatus').textContent = txt;
  }

  function renderRing(){
    let fraction;
    if(timerMode==='countdown'){
      fraction = countdownTotalMs>0 ? Math.max(0, Math.min(1, (countdownTotalMs-elapsedMs)/countdownTotalMs)) : 0;
    } else {
      fraction = (elapsedMs % 60000) / 60000;
    }
    const ring = document.getElementById('ringProgress');
    ring.style.strokeDashoffset = RING_C * (1 - fraction);
    if(me){
      const task=linkedTaskId ? blocksForDateIn(state,new Date()).find(b=>b.id===linkedTaskId) : null;
      ring.style.stroke = task ? subjectColorIn(task.subject,state) : 'var(--accent)';
    }
    document.getElementById('ringOuter').classList.toggle('running', timerRunning);
  }

  let sessionStartClock = null;

  // ---------- distraction-free focus mode ----------
  let wakeLockSentinel = null;
  function updateFocusToggleVisibility(){
    const btn = document.getElementById('focusToggleBtn');
    if(btn) btn.classList.toggle('visible', timerRunning && !document.body.classList.contains('focus-active'));
    if(!timerRunning) exitFocusMode(); 
  }
  async function enterFocusMode(){
    if(!timerRunning) return; 
    document.body.classList.add('focus-active');
    document.getElementById('timerLinkFloatWrap')?.style.setProperty('display','none','important');
    document.getElementById('focusToggleBtn')?.style.setProperty('display','none','important');
    if('wakeLock' in navigator){
      try{ wakeLockSentinel = await navigator.wakeLock.request('screen'); }catch(e){}
    }
  }
  function exitFocusMode(){
    document.body.classList.remove('focus-active');
    document.getElementById('timerLinkFloatWrap')?.style.removeProperty('display');
    document.getElementById('focusToggleBtn')?.style.removeProperty('display');
    updateFocusToggleVisibility();
    if(wakeLockSentinel){ wakeLockSentinel.release().catch(()=>{}); wakeLockSentinel = null; }
  }
  document.getElementById('focusToggleBtn').addEventListener('click', (e)=>{
    e.preventDefault();
    e.stopPropagation(); 
    enterFocusMode();
  });
  document.getElementById('focusExitBtn').addEventListener('click', (e)=>{
    e.preventDefault();
    exitFocusMode(); 
  });
  document.body.addEventListener('click', (e)=>{
    if(!document.body.classList.contains('focus-active')) return;
    if(e.target.closest('.timer-controls')) return;
    exitFocusMode();
  });

  function notifyFirstSessionOfDayIfNeeded(){
    if(elapsedMs > 0) return;
    const todayKey = fmtDate(new Date());
    const alreadyLoggedToday = (state.sessions[todayKey]||[]).length > 0;
    if(alreadyLoggedToday) return;
    const flagKey = 'sb-notified-first-session-'+todayKey;
    if(localStorage.getItem(flagKey)) return;
    localStorage.setItem(flagKey, '1');
    notifyOthers(`${me.name} started studying today 📚`, null, 'studyStart');
  }
  document.getElementById('startBtn').addEventListener('click', ()=>{
    if(!timerRunning){
      const isFreshSessionStart = !sessionStartClock;
      timerRunning = true;
      lastTick = Date.now();
      if(!sessionStartClock) sessionStartClock = Date.now() - elapsedMs;
      document.getElementById('startBtn').textContent = 'Pause';
      setStatusText(timerMode==='countdown' ? 'focusing…' : 'running…');
      tickHandle = setInterval(tick, 250);
      const linkedTask=linkedTaskId ? blocksForDateIn(state,new Date()).find(b=>b.id===linkedTaskId) : null;
      const subjectId = linkedTask ? linkedTask.subject : '';
      setLiveStatus({
        studying:true, subject:subjectId, subjectName: subjectId ? subjectNameIn(subjectId, state) : '',
        linkedTaskId: linkedTaskId || null, mode:timerMode, startedAt:Date.now(), baseElapsedMs:elapsedMs, totalMs:countdownTotalMs
      });
      startSnapshotScheduler();
      document.getElementById('customFocusWheel').style.display='none';
      document.getElementById('countdownLenChips').style.display='none';
      document.getElementById('timerModeSwitch').classList.add('mode-collapsed');
      updateFocusToggleVisibility();
      updateRunningDeclutter();
      if(isFreshSessionStart) notifyOthers(`${me.name} started studying 📚`, null, 'studyStart');
      notifyFirstSessionOfDayIfNeeded();
      writeTimerSchedule(true);
      armLocalTimerEndAlert();
    } else {
      pauseTimer();
    }
  });
  function pauseTimer(){
    timerRunning = false;
    clearInterval(tickHandle);
    document.getElementById('startBtn').textContent = 'Resume';
    setStatusText('paused');
    renderTimerDigits();
    setLiveStatus({ studying:false, baseElapsedMs:elapsedMs });
    stopSnapshotScheduler();
    updateFocusToggleVisibility();
    updateRunningDeclutter();
    clearLocalTimerEndAlert();
    writeTimerSchedule(false);
  }
  const MAX_SESSION_MS = 4 * 60 * 60 * 1000; 
  function tick(){
    const now = Date.now();
    elapsedMs += (now - lastTick);
    lastTick = now;
    if(timerMode==='countdown' && elapsedMs >= countdownTotalMs){
      elapsedMs = countdownTotalMs;
      renderTimerDigits();
      finishSession(true);
      return;
    }
    if(elapsedMs >= MAX_SESSION_MS){
      elapsedMs = MAX_SESSION_MS;
      renderTimerDigits();
      finishSession(timerMode==='countdown', 'autostop');
      return;
    }
    renderTimerDigits();
    checkMilestone();
  }
  document.getElementById('resetBtn').addEventListener('click', ()=>{
    if(elapsedMs > 3000){
      finishSession(false);
    } else {
      hardReset();
    }
  });
  function todayTotalMinutes(){
    const key = fmtDate(new Date());
    return (state.sessions[key]||[]).reduce((sum,s)=> sum + (s.duration||0), 0);
  }
  function todayTotalMinutesIn(data){
    const key = fmtDate(new Date());
    return ((data.sessions||{})[key]||[]).reduce((sum,s)=> sum + (s.duration||0), 0);
  }
  function minutesOnDate(date){
    const key = fmtDate(date);
    return (state.sessions[key]||[]).reduce((sum,s)=> sum + (s.duration||0), 0);
  }
  function minutesOnDateIn(data, date){
    const key = fmtDate(date);
    return ((data.sessions||{})[key]||[]).reduce((sum,s)=> sum + (s.duration||0), 0);
  }
  function weekTotalMinutes(){
    const start = startOfWeek(new Date(), 0);
    let total = 0;
    for(let i=0;i<7;i++){
      const d = new Date(start); d.setDate(d.getDate()+i);
      if(d > new Date()) break;
      total += minutesOnDate(d);
    }
    return total;
  }
  function weekTotalMinutesIn(data){
    const start = startOfWeek(new Date(), 0);
    let total = 0;
    for(let i=0;i<7;i++){
      const d = new Date(start); d.setDate(d.getDate()+i);
      if(d > new Date()) break;
      total += minutesOnDateIn(data, d);
    }
    return total;
  }
  function computeStreakFor(data){
    const goal = (data.goals && data.goals.dailyMin) || 0;
    if(goal<=0) return 0;
    const minsOnFor = (d)=>{
      const key = fmtDate(d);
      return ((data.sessions||{})[key]||[]).reduce((sum,s)=> sum+(s.duration||0), 0);
    };
    let streak = 0;
    let cursor = new Date();
    if(minsOnFor(cursor) < goal) cursor.setDate(cursor.getDate()-1);
    while(minsOnFor(cursor) >= goal){
      streak++;
      cursor.setDate(cursor.getDate()-1);
    }
    return streak;
  }
  function computeStreak(){ return computeStreakFor(state); }
  function renderGoalCard(){
    const card = document.getElementById('goalCard');
    if(!card) return;
    const data = activeData();
    const goals = data.goals || {};
    if(!goals.dailyMin && !goals.weeklyMin){ card.style.display='none'; return; }
    const viewerId = isViewingSelf() ? me.id : viewingId;
    const streak = isViewingSelf() ? computeStreak() : computeStreakFor(data);
    const finishedToday = todayTotalMinutesIn(data);
    const liveToday = liveMinutesFor(liveCache[viewerId]);
    const todayMin = Math.max(finishedToday, liveToday);
    const weekMin = weekTotalMinutesIn(data) + Math.max(0, todayMin - finishedToday);
    const dailyPct = goals.dailyMin ? Math.min(100, (todayMin/goals.dailyMin)*100) : 0;
    const weeklyPct = goals.weeklyMin ? Math.min(100, (weekMin/goals.weeklyMin)*100) : 0;
    card.style.display = 'block';
    const self = isViewingSelf();
    const whoLabel = self ? '' : `<div style="font-size:11px; color:var(--chalk-faint); margin-bottom:8px;">${escapeHtml((usersList.find(u=>u.id===viewingId)||{}).name || 'Friend')}'s goals</div>`;
    card.innerHTML = `
      ${whoLabel}
      <div class="row1">
        <div class="streak">🔥 <b>${streak}</b> day streak</div>
      </div>
      ${goals.dailyMin ? `
      <div class="goal-bar-row">
        <div class="goal-bar-label"><span>Today</span><span>${self ? `${fmtHM(todayMin)} / ${fmtHM(goals.dailyMin)}` : `${fmtHM(todayMin)} done`}</span></div>
        <div class="goal-bar-track"><div class="goal-bar-fill" style="width:${dailyPct}%;"></div></div>
      </div>` : ''}
      ${goals.weeklyMin ? `
      <div class="goal-bar-row">
        <div class="goal-bar-label"><span>This week</span><span>${self ? `${fmtHM(weekMin)} / ${fmtHM(goals.weeklyMin)}` : `${fmtHM(weekMin)} done`}</span></div>
        <div class="goal-bar-track"><div class="goal-bar-fill week" style="width:${weeklyPct}%;"></div></div>
      </div>` : ''}
    `;
  }
  function hardReset(){
    timerRunning = false;
    clearInterval(tickHandle);
    elapsedMs = 0;
    sessionStartClock = null;
    document.getElementById('startBtn').textContent = 'Start';
    document.getElementById('timerModeSwitch').classList.remove('mode-collapsed');
    if(timerMode==='countdown') document.getElementById('countdownLenChips').style.display='flex';
    document.getElementById('customFocusWheel').style.display='none';
    setStatusText('ready');
    renderTimerDigits();
    setLiveStatus({ studying:false, baseElapsedMs:0, todayTotalMin: todayTotalMinutes() });
    stopSnapshotScheduler();
    lastMilestoneHourLocal = 0;
    updateFocusToggleVisibility();
    updateRunningDeclutter();
    clearLocalTimerEndAlert();
    writeTimerSchedule(false);
  }
  function finishSession(completed, reason){
    timerRunning = false;
    clearInterval(tickHandle);
    clearLocalTimerEndAlert();
    writeTimerSchedule(false);
    const startedAtMs = sessionStartClock || (Date.now() - elapsedMs);
    const key = fmtDate(new Date(startedAtMs));
    if(!state.sessions[key]) state.sessions[key] = [];
    const linkedTask=linkedTaskId ? blocksForDateIn(state,parseDateKey(key)).find(b=>b.id===linkedTaskId) : null;
    const subjectId = linkedTask ? linkedTask.subject : '';
    const durationMin = Math.round(elapsedMs/60000 * 10)/10;
    const endedAt = Date.now();
    let justLoggedSession = null;
    if(durationMin > 0){
      const totalBefore = state.sessions[key].reduce((s,x)=>s+(x.duration||0),0);
      justLoggedSession = {
        id: 'sess_'+Date.now(),
        subject: subjectId,
        duration: durationMin,
        mode: timerMode,
        completed: completed,
        linkedTaskId: linkedTaskId || null,
        startedAt: startedAtMs,
        endedAt: endedAt
      };
      state.sessions[key].push(justLoggedSession);
      updateLinkedTaskProgress(key, justLoggedSession.linkedTaskId);
      saveState();
      const dailyGoalMin = (state.goals && state.goals.dailyMin) || 0;
      if(dailyGoalMin > 0){
        const totalAfter = totalBefore + durationMin;
        if(totalBefore < dailyGoalMin && totalAfter >= dailyGoalMin){
          const flagKey = 'sb-notified-goal-'+key;
          if(!localStorage.getItem(flagKey)){
            localStorage.setItem(flagKey, '1');
            notifyOthers(`${me.name} hit their daily goal today 🔥`, null, 'studyStart');
          }
        }
      }
    }
    setStatusText(reason==='autostop' ? 'auto-stopped at 4h limit 🛑' : (completed ? 'session complete 🎉' : 'ready'));
    document.getElementById('startBtn').textContent = 'Start';
    elapsedMs = 0;
    sessionStartClock = null;
    document.getElementById('timerModeSwitch').classList.remove('mode-collapsed');
    document.getElementById('customFocusWheel').style.display='none';
    document.getElementById('countdownLenChips').style.display = timerMode==='countdown' ? 'flex' : 'none';
    exitFocusMode();
    renderTimerDigits();
    renderSessions();
    renderTaskList();
    setLiveStatus({ studying:false, baseElapsedMs:0, todayTotalMin: todayTotalMinutes() });
    stopSnapshotScheduler();
    lastMilestoneHourLocal = 0;
    updateFocusToggleVisibility();
    updateRunningDeclutter();
    if(justLoggedSession && reason!=='autostop' && durationMin >= 1){
      promptSessionNote(justLoggedSession, key);
    }
  }
  function promptSessionNote(session, dateKey){
    const backdrop=document.createElement('div'); backdrop.className='modal-backdrop';
    const task= session.linkedTaskId ? blocksForDateIn(state,parseDateKey(dateKey)).find(b=>b.id===session.linkedTaskId) : null;
    backdrop.innerHTML=`<div class="modal"><button class="close-x">×</button><h3>What did you do?</h3><div class="field-row"><label>${escapeHtml(subjectName(session.subject))} · ${session.duration} min${task?' · '+escapeHtml(task.label||subjectNameIn(task.subject,state)):''}</label><textarea id="note-input" rows="3" placeholder="Optional note — you can skip this" style="width:100%;background:var(--card);border:1px solid var(--card-line);border-radius:10px;color:var(--chalk);padding:10px;font-family:'Inter';font-size:13px;resize:vertical;"></textarea></div><div class="modal-actions"><button class="btn btn-ghost" id="note-skip">Skip</button><button class="btn btn-primary" id="note-save">Save</button></div></div>`;
    document.body.appendChild(backdrop); function close(){backdrop.remove();}
    backdrop.querySelector('.close-x').addEventListener('click',close); backdrop.addEventListener('click',e=>{if(e.target===backdrop)close();});
    backdrop.querySelector('#note-skip').addEventListener('click',close);
    backdrop.querySelector('#note-save').addEventListener('click',async()=>{const text=backdrop.querySelector('#note-input').value.trim(); const s=(state.sessions[dateKey]||[]).find(x=>x.id===session.id); if(s&&text)s.note=text; await flushStateNow(); renderSessions(); close();});
  }
  function updateLinkedTaskProgress(dateKey, taskId){
    if(!taskId) return;
    const task=blocksForDateIn(state,parseDateKey(dateKey)).find(b=>b.id===taskId); if(!task) return;
    const total=(state.sessions[dateKey]||[]).filter(s=>s.linkedTaskId===taskId).reduce((sum,s)=>sum+(s.duration||0),0);
    const target=Number(task.duration||30);
    state.completion[dateKey+'|'+task.id] = total >= target ? 'done' : undefined;
    if(state.completion[dateKey+'|'+task.id]===undefined) delete state.completion[dateKey+'|'+task.id];
  }
  function linkedTaskProgress(data,dateKey,task){
    const target=Number(task.duration||30);
    const logged=((data.sessions||{})[dateKey]||[]).filter(s=>s.linkedTaskId===task.id).reduce((sum,s)=>sum+(s.duration||0),0);
    return {logged,target,pct:target?Math.min(100,Math.round(logged/target*100)):0,done:logged>=target};
  }

  const SNAP_SETTINGS_KEY = 'study-board-snap-settings';
  function loadSnapSettings(){
    let s = { enabled:false, facing:'user', freqMs:60000 };
    try{
      const raw = localStorage.getItem(SNAP_SETTINGS_KEY);
      if(raw) s = Object.assign(s, JSON.parse(raw));
    }catch(e){}
    return s;
  }
  function saveSnapSettings(s){
    try{ localStorage.setItem(SNAP_SETTINGS_KEY, JSON.stringify(s)); }catch(e){}
  }
  let snapSettings = loadSnapSettings();
  let camPausedManually = false;
  let camCaptureIntervalHandle = null;
  let camBusy = false;

  function captureOneFrame(isRetry){
    if(!snapSettings.enabled || camPausedManually || !timerRunning || !me || camBusy) return;
    if(!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return;
    camBusy = true;
    navigator.mediaDevices.getUserMedia({
      video:{ facingMode: snapSettings.facing, width:{ideal:320}, height:{ideal:320} },
      audio:false
    })
      .then(stream=>{
        const video = document.createElement('video');
        video.muted = true;
        video.playsInline = true;
        video.srcObject = stream;
        let settled = false;
        const cleanup = ()=>{ stream.getTracks().forEach(t=>t.stop()); camBusy = false; };
        const finishFail = ()=>{
          if(settled) return; settled = true;
          cleanup();
          if(!isRetry) setTimeout(()=> captureOneFrame(true), 500);
        };
        const grabFrame = ()=>{
          if(settled) return; settled = true;
          try{
            const size = 220;
            const canvas = document.createElement('canvas');
            canvas.width = size; canvas.height = size;
            const ctx = canvas.getContext('2d');
            const vw = video.videoWidth, vh = video.videoHeight;
            const s = Math.min(vw, vh);
            ctx.drawImage(video, (vw-s)/2, (vh-s)/2, s, s, 0, 0, size, size);
            const dataUrl = canvas.toDataURL('image/jpeg', 0.55);
            setLiveStatus({ snapshot: dataUrl, snapshotAt: Date.now(), freqMs: snapSettings.freqMs });
            renderSnapRow();
          }catch(e){ console.warn('snapshot capture failed', e); }
          cleanup();
        };
        video.onloadedmetadata = ()=>{
          video.play().then(()=>{
            const startWait = Date.now();
            const waitForFrame = ()=>{
              if(settled) return;
              if(video.readyState >= 2 && video.videoWidth > 0){
                grabFrame();
              } else if(Date.now() - startWait > 2500){
                finishFail(); 
              } else {
                requestAnimationFrame(waitForFrame);
              }
            };
            waitForFrame();
          }).catch(finishFail);
        };
        video.onerror = finishFail;
      })
      .catch(err=>{
        camBusy = false;
        if(!isRetry) setTimeout(()=> captureOneFrame(true), 800);
      });
  }

  function startSnapshotScheduler(){
    if(!snapSettings.enabled || camPausedManually || !timerRunning) return;
    if(camCaptureIntervalHandle) return; 
    captureOneFrame(); 
    camCaptureIntervalHandle = setInterval(()=>captureOneFrame(false), snapSettings.freqMs);
  }
  function stopSnapshotScheduler(){
    if(camCaptureIntervalHandle){ clearInterval(camCaptureIntervalHandle); camCaptureIntervalHandle = null; }
  }
  document.addEventListener('visibilitychange', ()=>{
    if(document.hidden){ stopSnapshotScheduler(); }
    else if(timerRunning){ startSnapshotScheduler(); }
  });

  function isSnapshotStale(st){
    if(!st || !st.snapshotAt) return false;
    const threshold = Math.max(3*60*1000, (st.freqMs || 60000) * 2.5);
    return (Date.now() - st.snapshotAt) > threshold;
  }
  function timeAgoShort(ts){
    const m = Math.max(1, Math.round((Date.now()-ts)/60000));
    return m + 'm ago';
  }

  async function sendNudge(targetId){
    if(!me || !targetId) return;
    try{ await setDoc(doc(db, 'nudges', targetId), { from: me.id, fromName: me.name, ts: Date.now() }); }catch(e){}
  }
  let lastSeenNudgeTs = 0;
  let nudgeUnsub = null;
  function showNudgeToast(text){
    const t = document.createElement('div');
    t.className = 'nudge-toast';
    t.textContent = text;
    document.body.appendChild(t);
    requestAnimationFrame(()=> t.classList.add('show'));
    setTimeout(()=>{ t.classList.remove('show'); setTimeout(()=> t.remove(), 350); }, 3200);
  }
  function subscribeSelfNudges(){
    if(nudgeUnsub) nudgeUnsub();
    nudgeUnsub = onSnapshot(doc(db, 'nudges', me.id), (snap)=>{
      if(!snap.exists()) return;
      const n = snap.data();
      if(n.ts && n.ts > lastSeenNudgeTs){
        lastSeenNudgeTs = n.ts;
        showNudgeToast(`👋 ${n.fromName || 'A friend'} is cheering you on`);
      }
    }, ()=>{});
  }

  function fireConfetti(together){
    const colors = together ? ['#22D3EE','#FF5A5F','#FFFFFF'] : ['#22D3EE','#7FB3D5','#8FCB9B'];
    const count = together ? 36 : 22;
    for(let i=0;i<count;i++){
      const p = document.createElement('div');
      p.className = 'confetti-piece';
      p.style.left = (Math.random()*100)+'vw';
      p.style.background = colors[i % colors.length];
      p.style.animationDuration = (1.6 + Math.random()*1.2)+'s';
      p.style.opacity = (0.7 + Math.random()*0.3).toString();
      document.body.appendChild(p);
      setTimeout(()=> p.remove(), 3200);
    }
    const toast = document.createElement('div');
    toast.className = 'milestone-toast';
    toast.textContent = together ? '🎉 You and your study buddy just crossed an hour together!' : '🎉 Another hour down — keep going!';
    document.body.appendChild(toast);
    requestAnimationFrame(()=> toast.classList.add('show'));
    setTimeout(()=>{ toast.classList.remove('show'); setTimeout(()=> toast.remove(), 400); }, 2600);
  }
  let lastMilestoneHourLocal = 0;
  function checkMilestone(){
    const hourBucket = Math.floor(elapsedMs/3600000);
    if(hourBucket <= lastMilestoneHourLocal || hourBucket < 1) return;
    lastMilestoneHourLocal = hourBucket;
    setLiveStatus({ lastMilestoneHour: hourBucket, lastMilestoneAt: Date.now() });
    const friendSt = !isViewingSelf() ? liveCache[viewingId] : null;
    const together = !!(friendSt && friendSt.lastMilestoneHour===hourBucket && friendSt.lastMilestoneAt && (Date.now()-friendSt.lastMilestoneAt < 3*60000));
    fireConfetti(together);
  }

  let liveCache = {};
  let livePollHandle = null;
  let liveTickHandle = null;
  async function setLiveStatus(patch){
    if(!me) return;
    const merged = Object.assign({ name: me.name, color: me.color }, liveCache[me.id]||{}, patch, { updatedAt: Date.now() });
    liveCache[me.id] = merged;
    renderPeopleRow(); renderSnapRow();
    updateFriendTimerCard();
    try{
      await setDoc(doc(db, 'liveStatus', me.id), merged, { merge:true });
    }catch(e){}
  }
  async function getLiveStatus(uid){
    try{
      const snap = await getDoc(doc(db, 'liveStatus', uid));
      return snap.exists() ? snap.data() : null;
    }catch(e){ return null; }
  }
  async function refreshLiveStatuses(){
    if(!me) return;
    for(const u of usersList){ liveCache[u.id] = await getLiveStatus(u.id); }
    renderPeopleRow(); renderSnapRow();
    updateFriendTimerCard();
    refreshBellBadge();
  }
  function liveMinutesFor(st){
    let mins = (st && st.todayTotalMin) || 0;
    if(st && st.studying && st.startedAt){
      mins += ((st.baseElapsedMs||0) + (Date.now()-st.startedAt)) / 60000;
    }
    return mins;
  }
  function updateFriendTimerCard(){
    if(currentScreen!=='timer' || isViewingSelf()) return;
    const friend = usersList.find(u=>u.id===viewingId);
    const card = document.getElementById('friendTimerBanner');
    if(!friend || !card) return;
    const st = liveCache[friend.id];
    const studying = !!(st && st.studying);
    const mins = liveMinutesFor(st);
    card.innerHTML = `
      <div class="who">${studying?'🔴 ':''}${escapeHtml(friend.name)}</div>
      <div class="lbl">${studying ? (st.label || st.subjectName || 'studying now') : 'not studying right now'}</div>
      <div class="stat">${fmtHM(mins)}</div>
      <div class="lbl">studied today</div>
    `;
  }
  function startLiveTimers(){
    stopLiveTimers();
    refreshLiveStatuses();
    livePollHandle = setInterval(refreshLiveStatuses, 6000);
    liveTickHandle = setInterval(()=>{ renderPeopleRow(); renderSnapRow(); updateFriendTimerCard(); renderGoalCard(); }, 1000);
  }
  function stopLiveTimers(){
    if(livePollHandle){ clearInterval(livePollHandle); livePollHandle = null; }
    if(liveTickHandle){ clearInterval(liveTickHandle); liveTickHandle = null; }
  }

  let selfLiveUnsub = null;
  function subscribeSelfLiveStatus(){
    if(selfLiveUnsub) selfLiveUnsub();
    selfLiveUnsub = onSnapshot(doc(db, 'liveStatus', me.id), (snap)=>{
      const st = snap.exists() ? snap.data() : null;
      liveCache[me.id] = st;
      reconcileLocalTimerFromRemote(st);
      renderPeopleRow(); renderSnapRow();
      updateFriendTimerCard();
    }, (err)=>{});
  }
  function reconcileLocalTimerFromRemote(st){
    if(!st || !me) return;
    if(st.studying && st.startedAt){
      if(!timerRunning || sessionStartClock !== st.startedAt){
        applyModeUI(st.mode || 'stopwatch');
        if(st.totalMs) countdownTotalMs = st.totalMs;
        sessionStartClock = st.startedAt;
        elapsedMs = (st.baseElapsedMs||0) + (Date.now() - st.startedAt);
        timerRunning = true;
        lastTick = Date.now();
        clearInterval(tickHandle);
        tickHandle = setInterval(tick, 250);
        document.getElementById('startBtn').textContent = 'Pause';
        setStatusText(st.mode==='countdown' ? 'focusing… (synced)' : 'running… (synced)');
        renderTimerDigits();
        updateRunningDeclutter();
      }
    } else {
      if(timerRunning){
        timerRunning = false;
        clearInterval(tickHandle);
        elapsedMs = st.baseElapsedMs || 0;
        sessionStartClock = null;
        document.getElementById('startBtn').textContent = elapsedMs>0 ? 'Resume' : 'Start';
        setStatusText(elapsedMs>0 ? 'paused (stopped on another device)' : 'ready');
        renderTimerDigits();
        updateRunningDeclutter();
      }
    }
  }

  function commentsIdFor(taskId, ownerId){
    return ownerId ? `p_${ownerId}_${taskId}` : `s_${taskId}`;
  }
  async function loadComments(cid){
    try{
      const snap = await getDoc(doc(db, 'comments', cid));
      return snap.exists() ? (snap.data().items || []) : [];
    }catch(e){ return []; }
  }
  async function addComment(cid, text){
    const items = await loadComments(cid);
    items.push({ by: me.id, name: me.name, text, ts: Date.now() });
    try{ await setDoc(doc(db, 'comments', cid), { items }); }catch(e){}
  }
  async function checkUnread(btn){
    const cid = btn.dataset.cid;
    const items = await loadComments(cid);
    if(!items.length) return;
    const lastRead = myReads[cid] || 0;
    const unread = items.some(c => c.ts > lastRead && c.by !== me.id);
    if(unread) btn.classList.add('has-unread');
  }
  function attachCommentButtons(el){
    el.querySelectorAll('.cmt-btn').forEach(btn=>{
      btn.addEventListener('click', ()=> openCommentsModal(btn.dataset.cid, btn.dataset.title, btn));
      checkUnread(btn);
    });
  }
  async function openCommentsModal(cid, title, btnEl){
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.innerHTML = `
      <div class="modal" style="max-height:75vh; display:flex; flex-direction:column;">
        <button class="close-x">×</button>
        <h3>${escapeHtml(title)}</h3>
        <div id="cmt-list" style="flex:1; overflow-y:auto; margin-bottom:14px; max-height:45vh;"></div>
        <div style="display:flex; gap:8px;">
          <input type="text" id="cmt-input" placeholder="Send a reminder or nudge…" style="flex:1;">
          <button class="btn btn-primary" id="cmt-send" style="flex:0 0 auto; padding:0 18px;">Send</button>
        </div>
      </div>
    `;
    document.body.appendChild(backdrop);
    await markRead(cid);
    if(btnEl) btnEl.classList.remove('has-unread');
    function close(){ document.body.removeChild(backdrop); }
    backdrop.querySelector('.close-x').addEventListener('click', close);
    backdrop.addEventListener('click', (e)=>{ if(e.target===backdrop) close(); });

    async function refresh(){
      const items = await loadComments(cid);
      const list = backdrop.querySelector('#cmt-list');
      list.innerHTML = items.length ? items.map(c=>`
        <div class="cmt-item"><b>${escapeHtml(c.name)}</b>: ${escapeHtml(c.text)}</div>
      `).join('') : `<div style="color:var(--chalk-faint); font-size:12px;">No messages yet — send the first nudge.</div>`;
      list.scrollTop = list.scrollHeight;
    }
    await refresh();
    async function send(){
      const input = backdrop.querySelector('#cmt-input');
      const text = input.value.trim();
      if(!text) return;
      input.value = '';
      await addComment(cid, text);
      await refresh();
      notifyForComment(cid, title, text);
    }
    backdrop.querySelector('#cmt-send').addEventListener('click', send);
    backdrop.querySelector('#cmt-input').addEventListener('keydown', (e)=>{ if(e.key==='Enter') send(); });
  }

  function renderSubjectOptions(selectEl, selectedId){
    selectEl.innerHTML = '';
    state.subjects.forEach(s=>{
      const opt = document.createElement('option');
      opt.value = s.id; opt.textContent = s.name;
      if(s.id === selectedId) opt.selected = true;
      selectEl.appendChild(opt);
    });
  }

  function renderSessions(){
    const key = fmtDate(new Date());
    const el = document.getElementById('sessionList');
    const titleEl = document.getElementById('sessionListTitle');
    const data = activeData();
    const editable = isViewingSelf();
    const friendName = !editable ? ((usersList.find(u=>u.id===viewingId)||{}).name || 'Friend') : null;
    if(titleEl) titleEl.textContent = editable ? "Today's sessions" : `${friendName}'s sessions today`;

    const list = (data.sessions && data.sessions[key]) || [];
    if(!list.length){
      el.innerHTML = `<div class="empty" style="padding:20px 0;"><div class="big">No sessions yet</div>${editable ? "today's first block starts with you" : escapeHtml(friendName)+" hasn't logged anything today"}</div>`;
      return;
    }
    el.innerHTML = list.slice().reverse().map(s=>{
      const period = (s.startedAt && s.endedAt) ? `${formatClock(s.startedAt)} – ${formatClock(s.endedAt)}` : '';
      return `
        <div class="session-item2">
          <div class="row1">
            <span class="subj"><span class="dot" style="background:${subjectColorIn(s.subject, data)}"></span>${subjectNameIn(s.subject, data)}</span>
            <span style="display:flex; align-items:center; gap:6px;">
              <span class="dur-badge">${fmtHM(s.duration)}${s.mode==='countdown' ? (s.completed?' ✓':' ⏸'):''}</span>
              ${editable ? `<button type="button" class="task-edit sess-edit" data-id="${s.id}" title="Edit session">✏️</button>` : ''}
            </span>
          </div>
          ${s.label ? `<div class="label">${escapeHtml(s.label)}</div>` : ''}
          ${period ? `<div class="period">${period}</div>` : ''}
          ${s.note ? `<div class="session-note">📝 ${escapeHtml(s.note)}</div>` : ''}
        </div>
      `;
    }).join('');
    if(!editable) return;
    el.querySelectorAll('.sess-edit').forEach(btn=>{
      btn.addEventListener('click', ()=>{
        const s = list.find(x=>x.id===btn.dataset.id);
        if(s) openEditSessionModal(s, key);
      });
    });
  }

  function openEditSessionModal(session, dateKey){
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.innerHTML = `
      <div class="modal">
        <button class="close-x">×</button>
        <h3>Edit session</h3>
        <div class="field-row">
          <label>Subject</label>
          <select id="es-subject"></select>
        </div>
        <div class="field-row">
          <label>Duration (minutes)</label>
          <input type="number" id="es-duration" min="1" step="1" value="${Math.round(session.duration)}">
        </div>
        <div class="field-row">
          <label>Linked daily target</label>
          <select id="es-linked">
            <option value="">Not linked</option>
            ${blocksForDateIn(state, parseDateKey(dateKey)).map(t=>`<option value="${t.id}" ${session.linkedTaskId===t.id?'selected':''}>${escapeHtml(t.label||subjectNameIn(t.subject,state))} · ${t.duration||30} min</option>`).join('')}
          </select>
        </div>
        <div class="field-row">
          <label>Note</label>
          <textarea id="es-note" rows="2" style="width:100%; background:var(--card); border:1px solid var(--card-line); border-radius:10px; color:var(--chalk); padding:10px; font-family:'Inter'; font-size:13px; resize:vertical;">${escapeHtml(session.note||'')}</textarea>
        </div>
        <div class="modal-actions">
          <button class="btn btn-ghost" id="es-delete" style="color:var(--c1);">Delete session</button>
          <button class="btn btn-primary" id="es-save">Save</button>
        </div>
      </div>
    `;
    document.body.appendChild(backdrop);
    renderSubjectOptions(backdrop.querySelector('#es-subject'), session.subject);
    function close(){ document.body.removeChild(backdrop); }
    backdrop.querySelector('.close-x').addEventListener('click', close);
    backdrop.addEventListener('click', (e)=>{ if(e.target===backdrop) close(); });
    backdrop.querySelector('#es-delete').addEventListener('click', async ()=>{
      const key = fmtDate(new Date());
      state.sessions[key] = (state.sessions[key]||[]).filter(s=>s.id!==session.id);
      await flushStateNow();
      renderSessions();
      renderGoalCard();
      renderStudyChart();
      close();
    });
    backdrop.querySelector('#es-save').addEventListener('click', async ()=>{
      const newSubject = backdrop.querySelector('#es-subject').value;
      const newDuration = Math.max(1, parseInt(backdrop.querySelector('#es-duration').value||'1',10));
      const newNote = backdrop.querySelector('#es-note').value.trim();
      const newLinked = backdrop.querySelector('#es-linked').value || null;
      const key = dateKey;
      const s = (state.sessions[key]||[]).find(x=>x.id===session.id);
      if(s){
        s.linkedTaskId = newLinked;
        s.subject = newLinked ? ((blocksForDateIn(state, parseDateKey(key)).find(t=>t.id===newLinked)||{}).subject || newSubject) : newSubject;
        s.duration = newDuration;
        s.note = newNote || null;
        updateLinkedTaskProgress(key, s.linkedTaskId);
      }
      await flushStateNow();
      renderSessions();
      renderGoalCard();
      renderStudyChart();
      close();
    });
  }

  function renderDayScroller(){
    const el = document.getElementById('dayScroller');
    el.innerHTML='';
    const today = new Date();
    for(let i=-3;i<=10;i++){
      const d = new Date(today);
      d.setDate(today.getDate()+i);
      const chip = document.createElement('div');
      chip.className = 'day-chip' + (fmtDate(d)===fmtDate(selectedDate) ? ' active':'');
      chip.innerHTML = `<div class="dname">${DAY_NAMES[d.getDay()]}</div><div class="dnum">${d.getDate()}</div>`;
      chip.addEventListener('click', ()=>{ selectedDate = d; render(); });
      el.appendChild(chip);
    }
  }
  async function renderTaskList(){
    const el=document.getElementById('taskList'); const dateKey=fmtDate(selectedDate);
    const data=activeData();
    const blocks=blocksForDateIn(data,selectedDate);
    let html=`<h3 class="section-title">${isViewingSelf()?'My tasks':escapeHtml((usersList.find(u=>u.id===viewingId)||{}).name||'User')+'’s tasks'}</h3>`;
    if(!blocks.length){ html+=`<div class="empty" style="padding:26px 0;"><div class="big">Nothing scheduled</div>${isViewingSelf()?'tap + to add a task for this day':''}</div>`; el.innerHTML=html; return; }
    html+=blocks.map(b=>{
      const compKey=dateKey+'|'+b.id, status=(data.completion||{})[compKey];
      const prog=linkedTaskProgress(data,dateKey,b);
      const hasLinked=(data.sessions||{})[dateKey]?.some(s=>s.linkedTaskId===b.id);
      const pct = status==='done' ? 100 : prog.pct;
      const progressLabel = hasLinked ? `${prog.pct}%` : (status==='done' ? '100%' : '');
      const progressVisual = `<div class="check ${status||''}" data-key="${compKey}">${status==='done'?'✓':(status==='missed'?'✕':'')}</div>`;
      return `<div class="task-card progress-row ${status==='done'?'done':''} ${status==='missed'?'missed':''}" style="--progress:${pct}%;"><div class="time">${timeColHtml(b.start,b.duration||30)}</div>${progressVisual}<div class="body"><div class="name ${status==='done'?'strike':''}">${escapeHtml(b.label||subjectNameIn(b.subject,data))}<span class="progress-label">${progressLabel}</span></div><div class="meta"><span class="dot" style="background:${subjectColorIn(b.subject,data)}"></span>${escapeHtml(subjectNameIn(b.subject,data))} · ${b.duration||30} min${hasLinked?' · '+prog.logged+' min logged':''}</div>${b.linkedGoalId?`<div class="link-pill">🔗 ${escapeHtml(goalTitleFor(b.linkedGoalId,data))}</div>`:''}</div>${isViewingSelf()?`<button class="task-actions" data-id="${b.id}" data-source="${b.source}" title="Edit, comment or delete">⋯</button>`:`<button class="cmt-btn" data-cid="${commentsIdFor(b.id,viewingId||me.id)}" data-title="${escapeHtml(b.label||subjectNameIn(b.subject,data))}">💬</button>`}</div>`;
    }).join('');
    el.innerHTML=html;
    el.querySelectorAll('.check').forEach(c=>c.addEventListener('click',()=>{state.completion[c.dataset.key]=nextStatus(state.completion[c.dataset.key]);saveState();renderTaskList();renderWeeklyGoalsList();}));
    if(isViewingSelf()) el.querySelectorAll('.task-actions').forEach(btn=>btn.addEventListener('click',()=>openTaskActions(btn.dataset.id,btn.dataset.source)));
    attachCommentButtons(el);
  }
  function openTaskActions(id,source){
    const dateKey=fmtDate(selectedDate); const block=source==='template'?state.weeklyTemplate.find(b=>b.id===id):(state.dailyExtra[dateKey]||[]).find(b=>b.id===id); if(!block)return;
    const backdrop=document.createElement('div');backdrop.className='modal-backdrop';
    backdrop.innerHTML=`<div class="modal" style="text-align:center"><button class="close-x">×</button><h3>${escapeHtml(block.label||subjectNameIn(block.subject,state))}</h3><button class="btn btn-ghost" id="ta-edit" style="width:100%;margin-bottom:8px">✏️ Edit</button><button class="btn btn-ghost" id="ta-comment" style="width:100%;margin-bottom:8px">💬 Comment</button><button class="btn btn-ghost" id="ta-delete" style="width:100%;color:var(--c1)">Delete</button></div>`;
    document.body.appendChild(backdrop);function close(){backdrop.remove();}backdrop.querySelector('.close-x').addEventListener('click',close);backdrop.addEventListener('click',e=>{if(e.target===backdrop)close();});
    backdrop.querySelector('#ta-edit').addEventListener('click',()=>{close();openAddModal(source==='template'?'template':'extra',block);});
    backdrop.querySelector('#ta-comment').addEventListener('click',()=>{close();openCommentsModal(commentsIdFor(block.id,me.id),block.label||subjectNameIn(block.subject,state));});
    backdrop.querySelector('#ta-delete').addEventListener('click',()=>{if(source==='template')state.weeklyTemplate=state.weeklyTemplate.filter(x=>x.id!==id);else state.dailyExtra[dateKey]=(state.dailyExtra[dateKey]||[]).filter(x=>x.id!==id);saveState();close();renderTaskList();renderWeeklyGoalsList();});
  }

  let weekOffset = 0;
  function startOfWeek(date, offsetWeeks){
    const d = new Date(date);
    d.setHours(0,0,0,0);
    const start = getWeekStartDay();
    const diff = (d.getDay() - start + 7) % 7;
    d.setDate(d.getDate() - diff + offsetWeeks*7);
    return d;
  }

  function linkedDoneItemsForGoal(data, goalId, weekStart){
    const items = [];
    for(let i=0;i<7;i++){
      const d = new Date(weekStart); d.setDate(d.getDate()+i);
      const dateKey = fmtDate(d);
      blocksForDateIn(data, d).forEach(b=>{
        if(b.linkedGoalId === goalId){
          const status = (data.completion||{})[dateKey+'|'+b.id];
          if(status==='done') items.push({ date:d, dateKey, block:b });
        }
      });
    }
    return items;
  }
  function weeklyGoalProgress(data, goal, weekStart){
    const items = linkedDoneItemsForGoal(data, goal.id, weekStart);
    const logged = goal.unit==='hours' ? items.reduce((s,it)=> s+(it.block.duration||0)/60, 0) : items.length;
    return { progress: Math.max(0, logged + (goal.manualAdjust||0)), items };
  }
  function recurringGroupsFor(data, weekStart){
    const wk = weekStartKey(weekStart);
    const map = {};
    (data.weeklyTemplate||[]).filter(b=>b.weekStart===wk).forEach(b=>{
      const key = b.subject + '|' + (b.label||'');
      if(!map[key]) map[key] = { key, subject:b.subject, label:b.label, blocks:[] };
      map[key].blocks.push(b);
    });
    return Object.values(map);
  }
  function recurringGroupStatus(data, group, weekStart){
    const dueDays = [...new Set(group.blocks.map(b=>b.day))].sort((a,b)=>a-b);
    const doneDays = [];
    const startDay = getWeekStartDay();
    dueDays.forEach(dow=>{
      const offset = (dow - startDay + 7) % 7;
      const d = new Date(weekStart); d.setDate(d.getDate()+offset);
      const dateKey = fmtDate(d);
      const blocksThatDay = group.blocks.filter(b=>b.day===dow);
      if(blocksThatDay.some(b => (data.completion||{})[dateKey+'|'+b.id] === 'done')) doneDays.push(dow);
    });
    return { dueDays, doneDays };
  }
  function donutSvg(pct, colorCss){
    const r = 20, c = 2*Math.PI*r;
    const off = c * (1 - Math.min(100,pct)/100);
    return `<svg viewBox="0 0 50 50">
      <circle class="donut-track" cx="25" cy="25" r="${r}"></circle>
      <circle class="donut-fill" cx="25" cy="25" r="${r}" stroke="${colorCss}" stroke-dasharray="${c}" stroke-dashoffset="${off}"></circle>
    </svg>`;
  }
  function fmtGoalAmt(n){ return Math.round(n*10)/10; }
  function goalTitleFor(goalId, data){
    const g = (data.weeklyGoals||[]).find(x=>x.id===goalId);
    return g ? g.title : 'goal';
  }

  let openGoalCardId = null;
  function renderWeeklyGoalsList(){
    const el = document.getElementById('weeklyGoalsList');
    if(!el) return;
    const editable = isViewingSelf();
    if(!editable && isScheduleHiddenFor(viewingId)){
      const label = document.getElementById('weekNavLabel');
      if(label) label.textContent = 'This week';
      el.innerHTML = `<div class="wgoal-empty">🙈 ${escapeHtml((usersList.find(u=>u.id===viewingId)||{}).name || 'This person')} has chosen to keep their schedule private.</div>`;
      return;
    }
    const data = activeData();
    const weekStart = startOfWeek(new Date(), weekOffset);
    const weekEnd = new Date(weekStart); weekEnd.setDate(weekEnd.getDate()+6);
    const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const labelEl = document.getElementById('weekNavLabel');
    if(labelEl){
      labelEl.textContent = weekOffset===0 ? 'This week' : `${MONTHS[weekStart.getMonth()]} ${weekStart.getDate()} – ${MONTHS[weekEnd.getMonth()]} ${weekEnd.getDate()}`;
      const sr=document.getElementById('weekStartRange'), er=document.getElementById('weekEndRange');
      if(sr) sr.textContent=`${DAY_NAMES[weekStart.getDay()]} · ${MONTHS[weekStart.getMonth()]} ${weekStart.getDate()}`;
      if(er) er.textContent=`${DAY_NAMES[weekEnd.getDay()]} · ${MONTHS[weekEnd.getMonth()]} ${weekEnd.getDate()}`;
    }

    const wk = weekStartKey(weekStart);
    const flexGoals = (data.weeklyGoals||[]).filter(g=>g.weekStart===wk);
    const groups = recurringGroupsFor(data, weekStart);

    if(groups.length===0 && flexGoals.length===0){
      el.innerHTML = `<div class="wgoal-empty">No weekly targets yet${editable ? ' — tap “+” to add one' : ''}.</div>`;
      return;
    }

    let html = '';

    groups.forEach(g=>{
      const { dueDays, doneDays } = recurringGroupStatus(data, g, weekStart);
      const pct = dueDays.length ? Math.round((doneDays.length/dueDays.length)*100) : 0;
      const cardId = 'rec_'+g.key.replace(/[^a-z0-9]/gi,'_');
      const isOpen = openGoalCardId === cardId;
      const title = g.label || subjectNameIn(g.subject, data);
      const dayDots = `<div class="day-dots">${[0,1,2,3,4,5,6].map(d=>{
        const due = dueDays.includes(d);
        const done = doneDays.includes(d);
        return `<div class="day-dot ${due?'due':''} ${done?'done':''}">${DAY_NAMES[d][0]}</div>`;
      }).join('')}</div>`;
      const linkedRows = dueDays.length ? dueDays.map(dow=>{
        const done = doneDays.includes(dow);
        const blocksThatDay = g.blocks.filter(b=>b.day===dow);
        if(blocksThatDay.length===0) return '';
        return blocksThatDay.map(b=>`
          <div class="linked-item">
            <span><span class="lday">${DAY_NAMES[dow]}</span><span class="lname">${escapeHtml(title)}</span></span>
            <span class="lamt">${done?'✓ done':'—'}</span>
          </div>
        `).join('');
      }).join('') : `<div class="linked-empty">No due days this week.</div>`;
      html += `
        <div class="wgoal-card ${isOpen?'open':''}" data-card="${cardId}">
          <div class="wgoal-top" data-toggle="${cardId}">
            <div class="donut-wrap">${donutSvg(pct, subjectColorIn(g.subject, data))}<div class="donut-pct">${pct}%</div></div>
            <div class="wgoal-info">
              <div class="wgoal-title-row">
                <span class="wgoal-title">${escapeHtml(title)}</span>
                <span class="type-chip recurring">recurring</span>
              </div>
              <div class="wgoal-frac"><b>${doneDays.length}</b> / ${dueDays.length} days this week</div>
            </div>
            <div class="chevron">▾</div>
          </div>
          ${dayDots}
          <div class="wgoal-expand">
            ${linkedRows}
            ${editable ? `<button type="button" class="edit rec-edit-group" data-rec-key="${g.key}" style="margin-top:10px;">✏️ Edit this recurring block</button>` : ''}
          </div>
        </div>
      `;
    });

    flexGoals.forEach(g=>{
      const { progress, items } = weeklyGoalProgress(data, g, weekStart);
      const pct = g.target ? Math.round(Math.min(100, (progress/g.target)*100)) : 0;
      const isOpen = openGoalCardId === g.id;
      const noun = g.unit==='hours' ? 'h' : (g.unit==='count' ? '' : (g.target===1?' session':' sessions'));
      const fracLabel = g.unit==='hours' ? `<b>${fmtGoalAmt(progress)}</b> / ${g.target}h` : `<b>${Math.round(progress)}</b> / ${g.target}${noun}`;
      const linkedRows = items.length ? items.map(it=>`
        <div class="linked-item">
          <span><span class="lday">${DAY_NAMES[it.date.getDay()]}</span><span class="lname">${escapeHtml(it.block.label || subjectNameIn(it.block.subject, data))}</span></span>
          <span class="lamt">${g.unit==='hours' ? fmtGoalAmt((it.block.duration||0)/60)+'h' : '1'}</span>
        </div>
      `).join('') : `<div class="linked-empty">No daily tasks linked yet this week.</div>`;
      html += `
        <div class="wgoal-card ${isOpen?'open':''}" data-card="${g.id}">
          <div class="wgoal-top" data-toggle="${g.id}">
            <div class="donut-wrap">${donutSvg(pct, subjectColorIn(g.subject, data))}<div class="donut-pct">${pct}%</div></div>
            <div class="wgoal-info">
              <div class="wgoal-title-row">
                <span class="wgoal-title">${escapeHtml(g.title)}</span>
                <span class="type-chip flexible">goal</span>
              </div>
              <div class="wgoal-frac">${fracLabel}</div>
              ${g.note ? `<div class="wgoal-note">${escapeHtml(g.note)}</div>` : ''}
            </div>
            <div class="chevron">▾</div>
          </div>
          <div class="wgoal-expand">
            ${g.note ? `<div class="wgoal-note-full">📝 ${escapeHtml(g.note)}</div>` : ''}
            ${linkedRows}
            ${editable ? `
            <div class="adjust-row">
              <span class="adjust-label">Manual adjust</span>
              <div class="stepper">
                <button type="button" class="step-btn" data-adjust="-1" data-id="${g.id}">−</button>
                <span class="step-val">${(g.manualAdjust||0) >= 0 ? '+' : ''}${g.manualAdjust||0}</span>
                <button type="button" class="step-btn" data-adjust="1" data-id="${g.id}">+</button>
              </div>
            </div>
            <div class="wgoal-actions">
              <button type="button" class="edit" data-edit="${g.id}">Edit goal</button>
              <button type="button" class="del" data-del="${g.id}">Delete</button>
            </div>` : ''}
          </div>
        </div>
      `;
    });

    el.innerHTML = html;

    el.querySelectorAll('[data-toggle]').forEach(node=>{
      node.addEventListener('click', ()=>{
        const id = node.dataset.toggle;
        openGoalCardId = openGoalCardId === id ? null : id;
        renderWeeklyGoalsList();
      });
    });
    if(!editable) return;
    el.querySelectorAll('[data-adjust]').forEach(btn=>{
      btn.addEventListener('click', (e)=>{
        e.stopPropagation();
        const g = state.weeklyGoals.find(x=>x.id===btn.dataset.id);
        if(g){ g.manualAdjust = (g.manualAdjust||0) + Number(btn.dataset.adjust); saveState(); renderWeeklyGoalsList(); }
      });
    });
    el.querySelectorAll('[data-edit]').forEach(btn=>{
      btn.addEventListener('click', (e)=>{
        e.stopPropagation();
        const g = state.weeklyGoals.find(x=>x.id===btn.dataset.edit);
        if(g) openGoalModal(g);
      });
    });
    el.querySelectorAll('[data-del]').forEach(btn=>{
      btn.addEventListener('click', (e)=>{
        e.stopPropagation();
        state.weeklyGoals = state.weeklyGoals.filter(g=>g.id!==btn.dataset.del);
        openGoalCardId = null;
        saveState();
        renderWeeklyGoalsList();
      });
    });
    el.querySelectorAll('.rec-edit-group').forEach(btn=>{
      btn.addEventListener('click', (e)=>{
        e.stopPropagation();
        const group = recurringGroupsFor(data, weekStart).find(g=>g.key===btn.dataset.recKey);
        if(group) openEditRecurringGroupModal(group, weekStart);
      });
    });
  }
  document.getElementById('weekStartPen').addEventListener('click',()=>{
    const backdrop=document.createElement('div');backdrop.className='modal-backdrop';
    backdrop.innerHTML=`<div class="modal"><button class="close-x">×</button><h3>Week start</h3><div class="field-row"><label>Choose the first day of your week</label><select id="week-start-select">${DAY_NAMES.map((n,i)=>`<option value="${i}" ${getWeekStartDay()===i?'selected':''}>${n}</option>`).join('')}</select></div><div class="modal-actions"><button class="btn btn-ghost" id="ws-cancel">Cancel</button><button class="btn btn-primary" id="ws-save">Save</button></div></div>`;
    document.body.appendChild(backdrop);function close(){backdrop.remove();}backdrop.querySelector('.close-x').addEventListener('click',close);backdrop.querySelector('#ws-cancel').addEventListener('click',close);backdrop.querySelector('#ws-save').addEventListener('click',()=>{const nextStart=Number(backdrop.querySelector('#week-start-select').value); const oldStart=getWeekStartDay(); migrateWeekStartSetting(oldStart,nextStart); state.weekStartDay=nextStart; saveState();weekOffset=0;openGoalCardId=null;renderWeeklyGoalsList();close();});
  });
  document.getElementById('weekPrev').addEventListener('click', ()=>{ weekOffset--; openGoalCardId=null; renderWeeklyGoalsList(); });
  document.getElementById('weekNext').addEventListener('click', ()=>{ weekOffset++; openGoalCardId=null; renderWeeklyGoalsList(); });

  function openEditRecurringGroupModal(group, weekStart){
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    const wk = weekStartKey(weekStart);
    const firstBlock = group.blocks[0];
    const dueDaysSet = new Set(group.blocks.map(b=>b.day));
    backdrop.innerHTML = `
      <div class="modal">
        <button class="close-x">×</button>
        <h3>Edit recurring block</h3>
        <div class="field-row">
          <label>Label</label>
          <input type="text" id="rg-label" value="${escapeHtml(group.label||'')}" placeholder="e.g. CSAT">
        </div>
        <div class="field-row">
          <label>Subject</label>
          <select id="rg-subject"></select>
        </div>
        <div class="field-row">
          <label>Start time</label>
          <div id="rg-start-wheel"></div>
        </div>
        <div class="field-row">
          <label>Duration</label>
          <div id="rg-duration-wheel"></div>
        </div>
        <div class="field-row">
          <label>Days this repeats</label>
          <div class="day-toggle-row" id="rg-days">
            ${DAY_NAMES.map((n,i)=>`<div class="day-toggle ${dueDaysSet.has(i)?'sel':''}" data-day="${i}">${n}</div>`).join('')}
          </div>
        </div>
        <div class="modal-actions">
          <button class="btn btn-ghost" id="rg-cancel">Cancel</button>
          <button class="btn btn-primary" id="rg-save">Save changes</button>
        </div>
        <button class="btn btn-danger" id="rg-delete-all" style="width:100%; margin-top:10px;">Delete entire recurring block</button>
      </div>
    `;
    document.body.appendChild(backdrop);
    renderSubjectOptions(backdrop.querySelector('#rg-subject'), firstBlock.subject);
    const startWheel = createTimeWheel(backdrop.querySelector('#rg-start-wheel'), firstBlock.start || '16:00');
    const durationWheel = createDurationStepper(backdrop.querySelector('#rg-duration-wheel'), firstBlock.duration || 30);

    const selectedDays = new Set(dueDaysSet);
    backdrop.querySelectorAll('#rg-days .day-toggle').forEach(d=>{
      d.addEventListener('click', ()=>{
        const day = parseInt(d.dataset.day,10);
        if(selectedDays.has(day)){ selectedDays.delete(day); d.classList.remove('sel'); }
        else { selectedDays.add(day); d.classList.add('sel'); }
      });
    });

    function close(){ document.body.removeChild(backdrop); }
    backdrop.querySelector('.close-x').addEventListener('click', close);
    backdrop.querySelector('#rg-cancel').addEventListener('click', close);
    backdrop.addEventListener('click', (e)=>{ if(e.target===backdrop) close(); });

    backdrop.querySelector('#rg-save').addEventListener('click', ()=>{
      if(selectedDays.size===0){ alert('Pick at least one day.'); return; }
      const label = backdrop.querySelector('#rg-label').value.trim();
      const subject = backdrop.querySelector('#rg-subject').value;
      const start = startWheel.getValue();
      const duration = durationWheel.getValue();

      const existingByDay = {};
      group.blocks.forEach(b=> existingByDay[b.day] = b);

      group.blocks.forEach(b=>{
        if(!selectedDays.has(b.day)) state.weeklyTemplate = state.weeklyTemplate.filter(x=>x.id!==b.id);
      });
      selectedDays.forEach(day=>{
        const existing = existingByDay[day];
        if(existing){
          existing.subject = subject; existing.start = start; existing.duration = duration; existing.label = label || null;
        } else {
          state.weeklyTemplate.push({ id:'blk_'+Date.now()+'_'+day, day, subject, start, duration, label: label||null, weekStart: wk });
        }
      });
      saveState();
      openGoalCardId = null;
      renderWeeklyGoalsList();
      close();
    });

    backdrop.querySelector('#rg-delete-all').addEventListener('click', ()=>{
      group.blocks.forEach(b=>{ state.weeklyTemplate = state.weeklyTemplate.filter(x=>x.id!==b.id); });
      saveState();
      openGoalCardId = null;
      renderWeeklyGoalsList();
      close();
    });
  }

  function openWeekGoalTypeChooser(){
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.innerHTML = `
      <div class="modal" style="text-align:center;">
        <button class="close-x">×</button>
        <h3>What kind of target?</h3>
        <div style="font-size:12px; color:var(--chalk-faint); margin-bottom:16px;">
          Recurring is a fixed day+time block that repeats this week (e.g. "CSAT every evening").<br>
          Flexible is an hours/sessions/count goal you chip away at from Today, any day you like.
        </div>
        <button class="btn btn-primary" id="chooser-recurring" style="width:100%; margin-bottom:10px;">📅 Recurring</button>
        <button class="btn btn-ghost" id="chooser-flexible" style="width:100%;">🎯 Flexible</button>
      </div>
    `;
    document.body.appendChild(backdrop);
    function close(){ document.body.removeChild(backdrop); }
    backdrop.querySelector('.close-x').addEventListener('click', close);
    backdrop.addEventListener('click', (e)=>{ if(e.target===backdrop) close(); });
    backdrop.querySelector('#chooser-recurring').addEventListener('click', ()=>{ close(); openAddModal('template'); });
    backdrop.querySelector('#chooser-flexible').addEventListener('click', ()=>{ close(); openGoalModal(); });
  }

  function openGoalModal(existingGoal){
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    const isEdit = !!existingGoal;
    const weekStart = startOfWeek(new Date(), weekOffset);
    const wk = weekStartKey(weekStart);
    backdrop.innerHTML = `
      <div class="modal">
        <button class="close-x">×</button>
        <h3>${isEdit ? 'Edit weekly goal' : 'Add weekly goal'}</h3>
        <div class="field-row">
          <label>Title</label>
          <input type="text" id="g-title" placeholder="e.g. Modern History" value="${escapeHtml(existingGoal?.title||'')}">
        </div>
        <div class="field-row">
          <label>Subject</label>
          <select id="g-subject"></select>
        </div>
        <div class="field-row">
          <label>Progress counted in</label>
          <select id="g-unit">
            <option value="hours">Hours</option>
            <option value="sessions">Sessions</option>
            <option value="count">Custom count</option>
          </select>
        </div>
        <div class="field-row">
          <label>Weekly target</label>
          <input type="number" id="g-target" min="0.5" step="0.5" value="${existingGoal?.target ?? 5}">
        </div>
        <div class="field-row">
          <label>Note <span style="opacity:.6; text-transform:none;">(optional)</span></label>
          <textarea id="g-note" rows="2" placeholder="e.g. Focus on map-based questions" style="width:100%; background:var(--card); border:1px solid var(--card-line); border-radius:10px; color:var(--chalk); padding:10px; font-family:'Inter'; font-size:13px; resize:vertical;">${escapeHtml(existingGoal?.note||'')}</textarea>
        </div>
        <div class="modal-actions">
          <button class="btn btn-ghost" id="g-cancel">Cancel</button>
          <button class="btn btn-primary" id="g-save">${isEdit?'Save changes':'Save goal'}</button>
        </div>
      </div>
    `;
    document.body.appendChild(backdrop);
    renderSubjectOptions(backdrop.querySelector('#g-subject'), existingGoal?.subject || state.subjects[0].id);
    const unitSel = backdrop.querySelector('#g-unit');
    unitSel.value = existingGoal?.unit || 'hours';

    function close(){ document.body.removeChild(backdrop); }
    backdrop.querySelector('.close-x').addEventListener('click', close);
    backdrop.querySelector('#g-cancel').addEventListener('click', close);
    backdrop.addEventListener('click', (e)=>{ if(e.target===backdrop) close(); });

    backdrop.querySelector('#g-save').addEventListener('click', ()=>{
      const title = backdrop.querySelector('#g-title').value.trim() || 'Untitled goal';
      const subject = backdrop.querySelector('#g-subject').value;
      const unit = unitSel.value;
      const target = Math.max(0.5, parseFloat(backdrop.querySelector('#g-target').value)||1);
      const note = backdrop.querySelector('#g-note').value.trim();
      if(isEdit){
        const g = state.weeklyGoals.find(x=>x.id===existingGoal.id);
        if(g){ g.title=title; g.subject=subject; g.type='flexible'; g.unit=unit; g.target=target; g.note=note||null; }
      } else {
        state.weeklyGoals.push({
          id:'wg_'+Date.now(), title, subject, type:'flexible', unit, target,
          weekStart: wk, note: note||null, manualAdjust:0, createdAt: Date.now()
        });
      }
      saveState();
      openGoalCardId = isEdit ? existingGoal.id : null;
      renderWeeklyGoalsList();
      close();
    });
  }

  // ---------- ADD MODAL ----------
  document.getElementById('fabAdd').addEventListener('click', ()=>{
    if(currentScreen==='today') openAddModal('extra');
    else if(currentScreen==='week' && isViewingSelf()) openWeekGoalTypeChooser();
  });

  const WHEEL_ITEM_H = 40;
  function buildWheelColumn(el, items, initialIndex, onSettle){
    el.innerHTML = `<div class="opt" style="visibility:hidden;"></div>` +
      items.map(v=>`<div class="opt">${v}</div>`).join('') +
      `<div class="opt" style="visibility:hidden;"></div>`;
    let current = Math.max(0, Math.min(items.length-1, initialIndex));
    function paintCenter(idx){
      el.querySelectorAll('.opt').forEach((o,i)=> o.classList.toggle('center', i===idx+1));
    }
    function scrollToIndex(idx, smooth){
      el.scrollTo({ top: idx*WHEEL_ITEM_H, behavior: smooth ? 'smooth' : 'auto' });
    }
    scrollToIndex(current, false);
    paintCenter(current);
    let settleTimer = null;
    el.addEventListener('scroll', ()=>{
      clearTimeout(settleTimer);
      settleTimer = setTimeout(()=>{
        let idx = Math.round(el.scrollTop / WHEEL_ITEM_H);
        idx = Math.max(0, Math.min(items.length-1, idx));
        current = idx;
        scrollToIndex(idx, true);
        paintCenter(idx);
        onSettle(items[idx], idx);
      }, 110);
    });
    return {
      get value(){ return items[current]; },
      setIndex(idx){ current = Math.max(0, Math.min(items.length-1, idx)); scrollToIndex(current, false); paintCenter(current); }
    };
  }
  function createTimeWheel(container, initialHHMM){
    container.innerHTML = `
      <div class="wheel-picker">
        <div class="wheel-col" id="${container.id}-h"></div>
        <div class="wheel-col" id="${container.id}-m"></div>
        <div class="wheel-col" id="${container.id}-a"></div>
        <div class="wheel-highlight"></div>
      </div>
      <div class="wheel-label" style="display:flex; gap:2px;"><span style="flex:1;">Hour</span><span style="flex:1;">Min</span><span style="flex:1;">AM/PM</span></div>
    `;
    let [ih, im] = (initialHHMM||'16:00').split(':').map(Number);
    let ampmInit = ih>=12 ? 'PM':'AM';
    let h12 = ih%12; if(h12===0) h12=12;
    const mIdx = Math.round(im/5) % 12; 
    const hours = Array.from({length:12}, (_,i)=> i+1);
    const mins = Array.from({length:12}, (_,i)=> pad(i*5));
    const ampms = ['AM','PM'];
    let hourVal = h12, minVal = mIdx*5, ampmVal = ampmInit;
    const hourWheel = buildWheelColumn(container.querySelector(`#${container.id}-h`), hours, hours.indexOf(h12), (v)=>{ hourVal = v; });
    const minWheel = buildWheelColumn(container.querySelector(`#${container.id}-m`), mins, mIdx, (v)=>{ minVal = parseInt(v,10); });
    const ampmWheel = buildWheelColumn(container.querySelector(`#${container.id}-a`), ampms, ampms.indexOf(ampmInit), (v)=>{ ampmVal = v; });
    return {
      getValue(){
        let h24 = hourVal % 12;
        if(ampmVal==='PM') h24 += 12;
        return `${pad(h24)}:${pad(minVal)}`;
      }
    };
  }
  function createDurationStepper(container, initialMin){
    let durVal = Math.max(30, Math.round((initialMin||30)/30)*30);
    container.innerHTML = `
      <div class="dur-stepper">
        <button type="button" class="dur-step-btn" id="${container.id}-minus">−</button>
        <div class="dur-step-val" id="${container.id}-val">${fmtHM(durVal)}</div>
        <button type="button" class="dur-step-btn" id="${container.id}-plus">+</button>
      </div>
    `;
    const valEl = container.querySelector(`#${container.id}-val`);
    const paint = ()=>{ valEl.textContent = fmtHM(durVal); };
    container.querySelector(`#${container.id}-minus`).addEventListener('click', ()=>{
      durVal = Math.max(30, durVal-30); paint();
    });
    container.querySelector(`#${container.id}-plus`).addEventListener('click', ()=>{
      durVal = Math.min(480, durVal+30); paint();
    });
    return { getValue(){ return durVal; } };
  }

  function openAddModal(kind, existingBlock, forcedDateKey){
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    const isTemplate = kind==='template';
    const isEdit = !!existingBlock;
    const dateKeyForExtra = forcedDateKey || fmtDate(selectedDate);
    const modalWeekStart = existingBlock?.weekStart || weekStartKey(startOfWeek(new Date(), isTemplate ? weekOffset : 0));
    backdrop.innerHTML = `
      <div class="modal" style="position:relative;">
        <button class="close-x">×</button>
        <h3>${isEdit ? (isTemplate?'Edit weekly block':'Edit task') : (isTemplate ? 'Add weekly block' : 'Add task for '+DAY_NAMES[selectedDate.getDay()]+' '+selectedDate.getDate())}</h3>
        ${isTemplate ? `<p class="modal-subhead">For this week only (${(()=>{const s=new Date(modalWeekStart); const e=new Date(s); e.setDate(e.getDate()+6); const M=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']; return `${M[s.getMonth()]} ${s.getDate()}–${M[e.getMonth()]} ${e.getDate()}`;})()})</p>` : ''}

        <div class="field-row">
          <label>Label</label>
          <input type="text" id="m-label" placeholder="e.g. Organic Chem — Ch.4" value="${escapeHtml(existingBlock?.label || '')}">
        </div>

        <div class="field-row">
          <label>Subject</label>
          <select id="m-subject"></select>
        </div>

        ${!isTemplate ? `
        <div class="field-row" id="m-link-goal-row">
          <label>Link to weekly goal <span style="opacity:.6; text-transform:none;">(optional, one click)</span></label>
          <select id="m-link-goal"><option value="">— none —</option></select>
        </div>` : ''}

        ${isTemplate && !isEdit ? `
        <div class="field-row">
          <label>Day(s)</label>
          <div class="day-toggle-row" id="m-days">
            ${DAY_NAMES.map((n,i)=>`<div class="day-toggle" data-day="${i}">${n}</div>`).join('')}
          </div>
        </div>` : ''}

        <div class="field-row">
          <label>Start time</label>
          <div id="m-start-wheel"></div>
        </div>

        <div class="field-row">
          <label>Duration</label>
          <div id="m-duration-wheel"></div>
        </div>

        ${!isEdit ? `
        <div class="field-row">
          <div class="together-toggle" id="m-together">
            <span class="check" id="m-together-check"></span>
            <span>We're doing this together</span>
          </div>
        </div>` : ''}

        <div class="field-row">
          <label>New subject color (optional — add a new subject)</label>
          <input type="text" id="m-new-subject" placeholder="New subject name">
          <div class="color-row" id="m-colors">
            ${COLORS.map(c=>`<div class="swatch" data-color="${c}" style="background:${c}"></div>`).join('')}
          </div>
        </div>

        <div class="modal-actions">
          <button class="btn btn-ghost" id="m-cancel">Cancel</button>
          <button class="btn btn-primary" id="m-save">${isEdit ? 'Save changes' : 'Save'}</button>
        </div>
      </div>
    `;
    document.body.appendChild(backdrop);
    renderSubjectOptions(backdrop.querySelector('#m-subject'), existingBlock?.subject || state.subjects[0].id);
    const startWheel = createTimeWheel(backdrop.querySelector('#m-start-wheel'), existingBlock?.start || '16:00');
    const durationWheel = createDurationStepper(backdrop.querySelector('#m-duration-wheel'), existingBlock?.duration || 30);
    const linkGoalSel = backdrop.querySelector('#m-link-goal');
    if(linkGoalSel){
      const wk = weekStartKey(selectedDate);
      const weekGoals = (state.weeklyGoals||[]).filter(g=>g.weekStart===wk);
      linkGoalSel.innerHTML = '<option value="">— none —</option>' +
        weekGoals.map(g=>`<option value="${g.id}">${escapeHtml(g.title)}</option>`).join('');
      if(existingBlock && existingBlock.linkedGoalId) linkGoalSel.value = existingBlock.linkedGoalId;
    }

    let pickedColor = COLORS[0];
    let selectedDays = (isTemplate && !isEdit) ? new Set([selectedDate.getDay()]) : null;
    if(isTemplate && !isEdit){
      const dayEls = backdrop.querySelectorAll('.day-toggle');
      dayEls.forEach(d=>{
        if(parseInt(d.dataset.day)===selectedDate.getDay()) d.classList.add('sel');
        d.addEventListener('click', ()=>{
          const day = parseInt(d.dataset.day);
          if(selectedDays.has(day)){ selectedDays.delete(day); d.classList.remove('sel'); }
          else { selectedDays.add(day); d.classList.add('sel'); }
        });
      });
    }
    backdrop.querySelectorAll('.swatch').forEach(sw=>{
      sw.addEventListener('click', ()=>{
        backdrop.querySelectorAll('.swatch').forEach(s=>s.classList.remove('sel'));
        sw.classList.add('sel');
        pickedColor = sw.dataset.color;
      });
    });

    let together = false;
    const togetherEl = backdrop.querySelector('#m-together');
    if(togetherEl){
      togetherEl.addEventListener('click', ()=>{
        together = !together;
        togetherEl.classList.toggle('sel', together);
        backdrop.querySelector('#m-together-check').textContent = together ? '✓' : '';
      });
    }

    function close(){ document.body.removeChild(backdrop); }
    backdrop.querySelector('.close-x').addEventListener('click', close);
    backdrop.querySelector('#m-cancel').addEventListener('click', close);
    backdrop.addEventListener('click', (e)=>{ if(e.target===backdrop) close(); });

    backdrop.querySelector('#m-save').addEventListener('click', async ()=>{
      const label = backdrop.querySelector('#m-label').value.trim();
      const start = startWheel.getValue();
      const duration = durationWheel.getValue();
      const newSubjectName = backdrop.querySelector('#m-new-subject').value.trim();
      let subjectId = backdrop.querySelector('#m-subject').value;

      if(newSubjectName){
        subjectId = 'sub_'+Date.now();
        state.subjects.push({id:subjectId, name:newSubjectName, color:pickedColor});
      }

      const taskName = label || subjectName(subjectId);

      if(isEdit){
        if(isTemplate){
          const blk = state.weeklyTemplate.find(b=>b.id===existingBlock.id);
          if(blk){ blk.subject = subjectId; blk.start = start; blk.duration = duration; blk.label = label; }
        } else {
          const list = state.dailyExtra[dateKeyForExtra] || [];
          const blk = list.find(b=>b.id===existingBlock.id);
          if(blk){
            blk.subject = subjectId; blk.start = start; blk.duration = duration; blk.label = label;
            if(linkGoalSel) blk.linkedGoalId = linkGoalSel.value || null;
          }
        }
        saveState();
        render();
        renderWeeklyGoalsList();
        close();
        return;
      }

      if(isTemplate){
        if(selectedDays.size===0){ selectedDays.add(selectedDate.getDay()); }
        if(together){
          const startDay = getWeekStartDay();
          for(const day of selectedDays){
            const offset = (day - startDay + 7) % 7;
            const d = new Date(modalWeekStart); d.setDate(d.getDate()+offset);
            const dateKey = fmtDate(d);
            const list = await loadSharedTasks(dateKey);
            list.push({
              id:'shr_'+Date.now()+'_'+day, start, duration, label,
              createdBy: me.id, createdByName: me.name,
              completions: {}
            });
            await saveSharedTasks(dateKey, list);
          }
          notifyOthers(`${me.name} added a shared weekly block: ${taskName}`, null, 'taskComment');
        } else {
          selectedDays.forEach(day=>{
            state.weeklyTemplate.push({
              id:'blk_'+Date.now()+'_'+day,
              day, subject:subjectId, start, duration, label, weekStart: modalWeekStart
            });
          });
          saveState();
        }
      } else if(together){
        const dateKey = fmtDate(selectedDate);
        const list = await loadSharedTasks(dateKey);
        list.push({
          id:'shr_'+Date.now(), start, duration, label,
          createdBy: me.id, createdByName: me.name,
          completions: {}
        });
        await saveSharedTasks(dateKey, list);
        notifyOthers(`${me.name} added a shared task: ${label || 'Untitled'}`, null, 'taskComment');
      } else {
        const key = fmtDate(selectedDate);
        if(!state.dailyExtra[key]) state.dailyExtra[key] = [];
        const linkGoalId = linkGoalSel ? (linkGoalSel.value || null) : null;
        state.dailyExtra[key].push({
          id:'ext_'+Date.now(), subject:subjectId, start, duration, label,
          linkedGoalId: linkGoalId
        });
        saveState();
      }
      render();
      close();
    });
  }

  function render(){
    renderPeopleRow(); renderSnapRow();
    renderLiveGroupPanel();

    const banner = document.getElementById('viewingBanner');
    if(currentScreen==='week' && !isViewingSelf()){
      const friend = usersList.find(u=>u.id===viewingId);
      banner.style.display = 'block';
      banner.textContent = `Viewing ${friend ? friend.name : 'their'} weekly schedule — read-only`;
    } else {
      banner.style.display = 'none';
    }

    const fab = document.getElementById('fabAdd');
    fab.style.display = (currentScreen==='today' || (currentScreen==='week' && isViewingSelf())) ? 'flex' : 'none';

    document.getElementById('timerControlsWrap').style.display = isViewingSelf() ? 'block' : 'none';
    document.getElementById('friendTimerBanner').style.display = isViewingSelf() ? 'none' : 'block';
    updateFriendTimerCard();
    renderGoalCard();

    renderTimerTaskLink();
    renderSessions();
    renderDayScroller();
    renderTaskList();
    renderWeeklyGoalsList();
    if(currentScreen==='history'){ renderHistoryCalendar(); renderHistory(); renderStudyChart(); }
  }

  document.getElementById('historyDate').addEventListener('change', async ()=>{
    const dateInput = document.getElementById('historyDate').value;
    if(!dateInput) return;
    const [y,m,d] = dateInput.split('-').map(Number);
    await resetHistoryFeed(new Date(y, m-1, d));
  });

  const DAY_FULL = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

  let chartRange = 'week'; 
  document.getElementById('chartRangeToggle').querySelectorAll('button').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      chartRange = btn.dataset.range;
      document.querySelectorAll('#chartRangeToggle button').forEach(b=>b.classList.remove('active'));
      btn.classList.add('active');
      renderStudyChart();
    });
  });
  document.getElementById('toggleHistoryList').addEventListener('click', ()=>{
    const wrap = document.getElementById('historyDetailWrap');
    const btn = document.getElementById('toggleHistoryList');
    const opening = wrap.style.display === 'none';
    wrap.style.display = opening ? 'block' : 'none';
    btn.textContent = opening ? '📋 Hide day-by-day tasks' : '📋 View day-by-day tasks';
  });

  function hoursToColor(hours){
    const h = Math.max(0, hours);
    let hue;
    if(h <= 1.5) hue = 140;
    else if(h <= 4) hue = 140 - ((h-1.5)/2.5) * (140-45);
    else if(h <= 7) hue = 45 - ((h-4)/3) * 45;
    else hue = 0;
    return `hsl(${hue.toFixed(0)}, 68%, 54%)`;
  }
  function computeChartBuckets(rangeType){
    const today = new Date(); today.setHours(0,0,0,0);
    const buckets = [];
    if(rangeType==='week' || rangeType==='fortnight'){
      const days = rangeType==='week' ? 7 : 14;
      for(let i=days-1; i>=0; i--){
        const d = new Date(today); d.setDate(d.getDate()-i);
        buckets.push({ label: DAY_FULL[d.getDay()][0], hours: minutesOnDate(d)/60, isToday: i===0 });
      }
    } else {
      for(let w=4; w>=0; w--){
        const end = new Date(today); end.setDate(end.getDate() - w*7);
        const start = new Date(end); start.setDate(start.getDate()-6);
        let sum = 0;
        for(let i=0;i<7;i++){
          const d = new Date(start); d.setDate(d.getDate()+i);
          if(d > today) break;
          sum += minutesOnDate(d)/60;
        }
        buckets.push({ label: `${start.getMonth()+1}/${start.getDate()}`, hours: sum, isToday: w===0 });
      }
    }
    return buckets;
  }
  function renderStudyChart(){
    const el = document.getElementById('studyChartWrap');
    if(!el) return;
    const buckets = computeChartBuckets(chartRange);
    const w = 320, h = 154, padL=26, padB=20, padT=16, padR=4;
    const plotW = w-padL-padR, plotH = h-padT-padB;
    const maxH = Math.max(2, ...buckets.map(b=>b.hours));
    const n = buckets.length;
    const gap = n>10 ? 3 : 6;
    const barW = (plotW - gap*(n-1)) / n;

    const points = buckets.map((b,i)=>{
      const x = padL + i*(barW+gap) + barW/2;
      const barH = Math.max(1, (b.hours/maxH) * plotH);
      const y = padT + (plotH - barH);
      return { x, y, barH, ...b };
    });

    let gridSvg = '';
    [0.5, 1].forEach(f=>{
      const gy = padT + plotH*(1-f);
      gridSvg += `<line x1="${padL}" y1="${gy}" x2="${w-padR}" y2="${gy}" stroke="rgba(255,255,255,0.07)" stroke-width="1"/>`;
      gridSvg += `<text x="${padL-4}" y="${gy+3}" font-size="7.5" fill="var(--chalk-faint)" text-anchor="end" font-family="JetBrains Mono">${fmtGoalAmt(maxH*f)}h</text>`;
    });

    const bars = points.map(p=>{
      const color = hoursToColor(p.hours);
      const rx = Math.min(4, barW/3);
      return `<rect x="${p.x-barW/2}" y="${p.y}" width="${barW}" height="${p.barH}" rx="${rx}" fill="${color}" opacity="${p.isToday?1:0.85}"/>`;
    }).join('');

    const linePath = points.map((p,i)=> (i===0?'M':'L') + p.x.toFixed(1) + ' ' + p.y.toFixed(1)).join(' ');
    const lineDots = points.map(p=>`<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="2.2" fill="var(--board)" stroke="var(--chalk)" stroke-width="1.3"/>`).join('');

    const showAllLabels = n<=14;
    const valueLabels = showAllLabels ? points.map(p=> p.hours>0.05 ? `<text x="${p.x}" y="${Math.max(p.y-6,padT+7)}" font-size="7" fill="var(--chalk-dim)" text-anchor="middle" font-family="JetBrains Mono">${fmtGoalAmt(p.hours)}</text>` : '').join('') : '';
    const xLabels = points.map(p=>`<text x="${p.x}" y="${h-5}" font-size="7.5" fill="var(--chalk-faint)" text-anchor="middle">${p.label}</text>`).join('');

    el.innerHTML = `
      <svg viewBox="0 0 ${w} ${h}" style="width:100%; height:auto; display:block; overflow:visible;">
        ${gridSvg}
        ${bars}
        <path d="${linePath}" fill="none" stroke="var(--chalk)" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round" opacity="0.8"/>
        ${lineDots}
        ${valueLabels}
        ${xLabels}
      </svg>
      <div class="chart-legend">
        <span><i style="background:hsl(140,68%,54%);"></i>light</span>
        <span><i style="background:hsl(45,68%,54%);"></i>moderate</span>
        <span><i style="background:hsl(0,68%,54%);"></i>heavy</span>
      </div>
    `;
  }

  let historyCalMonth = new Date(); historyCalMonth.setDate(1);
  function renderHistoryCalendar(){
    const el = document.getElementById('historyCalendar');
    if(!el) return;
    const data = activeData();
    const who = isViewingSelf() ? null : ((usersList.find(u=>u.id===viewingId)||{}).name || 'Friend');
    const y = historyCalMonth.getFullYear(), m = historyCalMonth.getMonth();
    const first = new Date(y,m,1);
    const startPad = first.getDay();
    const daysInMonth = new Date(y,m+1,0).getDate();
    const today = new Date();
    const selectedVal = document.getElementById('historyDate').value;
    let cells = '';
    for(let i=0;i<startPad;i++) cells += `<div class="hcal-cell empty"></div>`;
    for(let day=1; day<=daysInMonth; day++){
      const d = new Date(y,m,day);
      const key = fmtDate(d);
      const mins = minutesOnDateIn(data, d);
      const isFuture = d > today;
      const isToday = key === fmtDate(today);
      const isSelected = key === selectedVal;
      cells += `<div class="hcal-cell ${mins>0?'has-time':''} ${isFuture?'future':''} ${isToday?'today':''} ${isSelected?'selected':''}" data-date="${key}">
        <div class="d">${day}</div>
        ${mins>0 ? `<div class="h">${fmtHMCompact(mins)}</div>` : ''}
      </div>`;
    }
    const atCurrentMonth = (y===today.getFullYear() && m===today.getMonth());
    el.innerHTML = `
      <div class="hcal-nav">
        <button class="week-nav-arrow" id="hcalPrev">‹</button>
        <div class="hcal-nav-label">${MONTHS[m]} ${y}</div>
        <button class="week-nav-arrow" id="hcalNext" ${atCurrentMonth?'style="opacity:0.3;"':''}>›</button>
      </div>
      ${who ? `<div class="hcal-who">${escapeHtml(who)}'s history — tap your name above to switch back</div>` : ''}
      <div class="hcal-dow-row">
        ${DAY_NAMES.map(n=>`<div class="hcal-dow">${n}</div>`).join('')}
      </div>
      <div class="hcal-grid">
        ${cells}
      </div>
    `;
    el.querySelector('#hcalPrev').addEventListener('click', ()=>{
      historyCalMonth = new Date(y, m-1, 1); renderHistoryCalendar();
    });
    el.querySelector('#hcalNext').addEventListener('click', ()=>{
      if(atCurrentMonth) return;
      historyCalMonth = new Date(y, m+1, 1); renderHistoryCalendar();
    });
    el.querySelectorAll('.hcal-cell[data-date]').forEach(cell=>{
      cell.addEventListener('click', async ()=>{
        const key = cell.dataset.date;
        document.getElementById('historyDate').value = key;
        const [yy,mm,dd] = key.split('-').map(Number);
        await resetHistoryFeed(new Date(yy,mm-1,dd));
        renderHistoryCalendar();
      });
    });
  }
  let historyDates = [];
  let historyAnchor = null;
  let historyLoading = false;
  let historyInitialized = false;
  let historyLastViewingId = undefined;
  const HISTORY_BATCH = 10;
  const HISTORY_MAX_DAYS = 365;

  async function ensureAllFriendBoardsLoaded(){
    const friends = usersList.filter(u=>u.id!==me.id);
    for(const u of friends){ if(!friendCache[u.id]) await fetchFriendBoard(u.id); }
  }
  async function refreshAllFriendBoards(){
    const friends = usersList.filter(u=>u.id!==me.id);
    for(const u of friends){ await fetchFriendBoard(u.id); }
    renderPeopleRow(); renderSnapRow();
    renderSessions();
    renderGoalCard();
  }
  let friendBoardsPollHandle = null;

  async function renderHistoryDayBlock(date){
    const dateKey = fmtDate(date);
    const heading = `${DAY_FULL[date.getDay()]}, ${MONTHS[date.getMonth()]} ${date.getDate()}`;
    let body = '';
    const section = (title, blocks, data, ownerId)=>{
      if(!blocks.length) return '';
      return `<h3 class="section-title">${title}</h3>` + blocks.map(b=>{
        const compKey = dateKey+'|'+b.id;
        const status = (data.completion||{})[compKey];
        return `
          <div class="task-card readonly ${status==='done'?'done':''} ${status==='missed'?'missed':''}">
            <div class="time">${timeColHtml(b.start, b.duration||30)}</div>
            <div class="check ${status||''}" style="pointer-events:none;">${status==='done'?'✓':(status==='missed'?'✕':'')}</div>
            <div class="body">
              <div class="name ${status==='done'?'strike':''}">${b.label || subjectNameIn(b.subject, data)}</div>
              <div class="meta"><span class="dot" style="background:${subjectColorIn(b.subject, data)}"></span>${subjectNameIn(b.subject, data)} · ${b.duration||30} min</div>
            </div>
            <button class="cmt-btn" data-cid="${commentsIdFor(b.id, ownerId)}" data-title="${escapeHtml(b.label||subjectNameIn(b.subject,data))}">💬</button>
          </div>
        `;
      }).join('');
    };

    const data = activeData();
    const ownerId = isViewingSelf() ? me.id : viewingId;
    const ownerLabel = isViewingSelf() ? 'My tasks' : `${((usersList.find(u=>u.id===viewingId)||{}).name) || 'Their'}'s tasks`;
    if(isViewingSelf() || !isScheduleHiddenFor(viewingId)){
      body += section(ownerLabel, blocksForDateIn(data, date), data, ownerId);
    }

    const sharedTasks = await loadSharedTasks(dateKey);
    if(sharedTasks.length){
      body += `<h3 class="section-title">Done together</h3>` + sharedTasks.map(t=>{
        const people = [me, ...usersList.filter(u=>u.id!==me.id)];
        const rowHtml = people.map(p=>{
          const st = (t.completions||{})[p.id];
          return `<div class="who-chip ${st||''}" title="${p.name}">
            <span class="avatar" style="background:${p.color||'#7FB3D5'}">${p.name.slice(0,1).toUpperCase()}</span>
            <span class="who-mark">${st==='done'?'✓':(st==='missed'?'✕':'')}</span>
          </div>`;
        }).join('');
        return `
          <div class="task-card shared">
            <div class="time">${timeColHtml(t.start, t.duration||30)}</div>
            <div class="body">
              <div class="name">${t.label||'Untitled'} <span class="badge">together</span></div>
              <div class="meta">${t.duration||30} min</div>
              <div class="who-row">${rowHtml}</div>
            </div>
            <button class="cmt-btn" data-cid="${commentsIdFor(t.id, null)}" data-title="${escapeHtml(t.label||'Untitled')}">💬</button>
          </div>
        `;
      }).join('');
    }

    if(!body){ body = `<div style="font-size:12px; color:var(--chalk-faint); padding:2px 2px 4px;">Nothing logged</div>`; }
    return `<div class="history-day"><div class="history-day-heading">${heading}</div>${body}</div>`;
  }

  async function loadMoreHistoryDays(){
    if(historyLoading || historyDates.length >= HISTORY_MAX_DAYS) return;
    historyLoading = true;
    const el = document.getElementById('historyList');
    const startOffset = historyDates.length;
    let html = '';
    for(let i=0;i<HISTORY_BATCH;i++){
      const d = new Date(historyAnchor);
      d.setDate(d.getDate() - (startOffset+i));
      historyDates.push(d);
      html += await renderHistoryDayBlock(d);
    }
    el.insertAdjacentHTML('beforeend', html);
    attachCommentButtons(el);
    historyLoading = false;
  }

  async function resetHistoryFeed(anchorDate){
    historyDates = [];
    historyAnchor = new Date(anchorDate);
    document.getElementById('historyList').innerHTML = '';
    await ensureAllFriendBoardsLoaded();
    await loadMoreHistoryDays();
  }

  async function renderHistory(){
    const vid = viewingId || null;
    if(historyInitialized && historyLastViewingId === vid) return;
    historyInitialized = true;
    historyLastViewingId = vid;
    const dateInput = document.getElementById('historyDate').value || fmtDate(new Date());
    const [y,m,d] = dateInput.split('-').map(Number);
    await resetHistoryFeed(new Date(y, m-1, d));
  }

  document.querySelector('main').addEventListener('scroll', ()=>{
    if(currentScreen!=='history') return;
    const mainEl = document.querySelector('main');
    if(mainEl.scrollTop + mainEl.clientHeight > mainEl.scrollHeight - 400){
      loadMoreHistoryDays();
    }
  });

})();