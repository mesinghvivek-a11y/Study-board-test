import { initializeApp } from "https://www.gstatic.com/firebasejs/12.16.0/firebase-app.js";
import {
  getFirestore, doc, getDoc, getDocFromServer, setDoc, onSnapshot, deleteField, deleteDoc
} from "https://www.gstatic.com/firebasejs/12.16.0/firebase-firestore.js";
import {
  getAuth, signInWithEmailAndPassword, createUserWithEmailAndPassword,
  onAuthStateChanged, signOut, updateProfile,
  GoogleAuthProvider, signInWithPopup, signInWithRedirect, getRedirectResult
} from "https://www.gstatic.com/firebasejs/12.16.0/firebase-auth.js";
import {
  getMessaging, getToken, onMessage, isSupported as messagingIsSupported
} from "https://www.gstatic.com/firebasejs/12.16.0/firebase-messaging.js";
import {
  getDatabase, ref, set, get, onValue
} from "https://www.gstatic.com/firebasejs/12.16.0/firebase-database.js";

const firebaseConfig = {
  apiKey: "AIzaSyDj_aqkiOI3g8ti9_jkqLl_6FOu_HgphZQ",
  authDomain: "studyboardpro.firebaseapp.com",
  projectId: "studyboardpro",
  storageBucket: "studyboardpro.firebasestorage.app",
  messagingSenderId: "487214631768",
  appId: "1:706066762938:web:ee9273681379f7d04cb32d",
  measurementId: "G-SVK750HR2D"
};
const fbApp = initializeApp(firebaseConfig);
const db = getFirestore(fbApp);
const auth = getAuth(fbApp);
const rtdb = getDatabase(fbApp);

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
  const PALETTES = [
    { id:'cyan',    accent:'#22D3EE' },
    { id:'violet',  accent:'#8B5CF6' },
    { id:'rose',    accent:'#FB4570' },
    { id:'emerald', accent:'#12B981' },
    { id:'amber',   accent:'#F5A623' }
  ];
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
    weekStartDay: 0,
    themeMode: 'dark',
    themePalette: 'cyan'
  };

  let selectedDate = new Date();
  let currentScreen = 'timer';

  let me = null;              
  let allProfiles = [];       
  let usersList = [];         
  let viewingId = null;       
  let friendCache = {};       
  let myReads = {};           

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
        // PREVENTS INFINITE LOOP IF PERMISSION DENIED BY FIREBASE RULES
        if (e.code === 'permission-denied' || String(e).includes('permission')) {
            hideLoadBlocker();
            setAuthError("Database access denied. Please check your Firebase Firestore rules.");
            await signOut(auth);
            showAuth();
            return; 
        }
        attempts++;
        if (attempts >= 3) {
            hideLoadBlocker();
            alert("Failed to connect to Firebase database after 3 attempts.\nError: " + (e.message || e.code));
            await signOut(auth);
            showAuth();
            return;
        }
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
    applyTheme();
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
  const authScreen = document.getElementById('authScreen');
  const appRoot = document.getElementById('app');
  const authError = document.getElementById('authError');
  let isInitializing = false;
  
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

  // 1. MASTER AUTH LISTENER (Handles all logins automatically)
  onAuthStateChanged(auth, async (user)=>{
    if(user){
      if(isInitializing) return; 
      isInitializing = true;
      window.__meId = user.uid;
      try{
        const res = await window.storage.get('study-board-profile', false);
        me = res && res.value ? JSON.parse(res.value) : { id: user.uid, name: user.displayName || 'Student', color: COLORS[0], photo: user.photoURL || null };
      }catch(e){ 
        me = { id: user.uid, name: user.displayName || 'Student', color: COLORS[0], photo: user.photoURL || null }; 
      }
      showApp();
      await loadState();
      isInitializing = false;
    } else {
      isInitializing = false;
      me = null;
      window.__meId = null;
      showAuth();
    }
  });

  // 2. GOOGLE SIGN IN (Popup fallback to fix iOS loop)
  document.getElementById('googleAuthBtn').addEventListener('click', async (e)=>{
    e.preventDefault(); 
    setAuthError('');
    document.getElementById('googleAuthBtn').disabled = true;
    try {
      const provider = new GoogleAuthProvider();
      await signInWithPopup(auth, provider);
    } catch(e) {
      if(e.code !== 'auth/popup-closed-by-user' && e.code !== 'auth/cancelled-popup-request') {
         setAuthError(e.message || 'Google sign-in failed.');
      }
      document.getElementById('googleAuthBtn').disabled = false;
    }
  });

  // 3. EMAIL & PASSWORD LOGIN
  document.getElementById('authSubmit').addEventListener('click', async (e)=>{
    e.preventDefault(); 
    const email = document.getElementById('authEmail').value.trim();
    const password = document.getElementById('authPassword').value;
    const name = document.getElementById('authName').value.trim();
    setAuthError('');
    
    if(!email || !password){ setAuthError('Enter an email and password.'); return; }
    if(authMode==='signup' && !name){ setAuthError('Enter your name.'); return; }

    document.getElementById('authSubmit').disabled = true;

    try {
      if(authMode==='signup'){
        const cred = await createUserWithEmailAndPassword(auth, email, password);
        me = { id: cred.user.uid, name, color: COLORS[Math.floor(Math.random()*COLORS.length)] };
        await window.storage.set('study-board-profile', JSON.stringify(me), false);
        await registerUser(me);
      } else {
        await signInWithEmailAndPassword(auth, email, password);
      }
    } catch (e) {
      let readableMessage = "An error occurred during authentication.";
      if(e.code === 'auth/wrong-password' || e.code === 'auth/invalid-credential'){
        readableMessage = "Incorrect password or email address.";
      } else if(e.code === 'auth/user-not-found'){
        readableMessage = "No account found with that email.";
      } else if(e.code === 'auth/invalid-email'){
        readableMessage = "Please enter a valid email address.";
      } else {
        readableMessage = e.message || "Something went wrong.";
      }
      setAuthError(readableMessage);
      document.getElementById('authSubmit').disabled = false;
    }
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
      window.location.reload(); 
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
        <h4 class="modal-subhead">Appearance</h4>
        <div class="field-row">
          <div class="appearance-row">
            <div class="seg-row" id="acct-theme-mode">
              <button type="button" class="seg-btn ${(state.themeMode||'dark')==='dark'?'sel':''}" data-mode="dark" title="Dark">●</button>
              <button type="button" class="seg-btn ${state.themeMode==='light'?'sel':''}" data-mode="light" title="Light">☀</button>
            </div>
            <div class="color-row" id="acct-palette">
              ${PALETTES.map(p=>`<div class="swatch ${p.id===(state.themePalette||'cyan')?'sel':''}" data-palette="${p.id}" style="background:${p.accent}" title="${p.id}"></div>`).join('')}
            </div>
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

    backdrop.querySelectorAll('#acct-theme-mode .seg-btn').forEach(btn=>{
      btn.addEventListener('click', ()=>{
        backdrop.querySelectorAll('#acct-theme-mode .seg-btn').forEach(b=>b.classList.remove('sel'));
        btn.classList.add('sel');
        setThemeMode(btn.dataset.mode);
      });
    });
    backdrop.querySelectorAll('#acct-palette .swatch').forEach(sw=>{
      sw.addEventListener('click', ()=>{
        backdrop.querySelectorAll('#acct-palette .swatch').forEach(s=>s.classList.remove('sel'));
        sw.classList.add('sel');
        setThemePalette(sw.dataset.palette);
      });
    });

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

  // ---------- live snapshot sharing: settings, camera engine, milestones, nudges ----------
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
        console.warn('camera unavailable', err);
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
    try{ await setDoc(doc(db, 'comments', cid), { items }); }
    catch(e){ console.error('comment failed', e); }
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

  // ---------- RESTORED WEEK SCREEN (PLAN TAB) ----------
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
    dueDays.forEach(dow=>{
      const d = new Date(weekStart); d.setDate(d.getDate()+dow);
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
          <label>Note <span style="opacity:.6; text-transform:none;">(optional — what to focus on)</span></label>
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
        notifyOthers(`${me.name} set a new weekly goal: ${title}`);
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
          for(const day of selectedDays){
            const d = new Date(modalWeekStart); d.setDate(d.getDate()+day);
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
          notifyOthers(`${me.name} added a weekly study block: ${taskName}`, null, 'taskComment');
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
        notifyOthers(`${me.name} added a task: ${taskName}`, null, 'taskComment');
      }
      render();
      close();
    });
  }

  function renderFocusPresetNames() { }

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

  // ---------- study-hours chart (Analyse screen) ----------
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
