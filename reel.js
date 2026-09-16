/* reel.js — record a reel of this tab: its picture + its sound + your mic (+ your camera as a small circle),
   cropped 9:16 for Instagram, saved as a webm to Downloads (./reel2mp4.sh turns it into an mp4).
   Shared by world.html and clouds.html:  installReel(container, { compact })  builds the controls inside
   `container` (a panel or a toolbar), binds the r key, and shows a red dot while recording. */
window.installReel = function (container, opts = {}) {
  const compact = !!opts.compact;   // in a one-line toolbar: no status line under the button, status goes to the title
  const css = document.createElement('style');
  css.textContent = `
    #rBtn.rec { border-color: #ff6a6a; color: #ff6a6a; }
    #recDot { position: absolute; right: 14px; top: 44px; z-index: 8; color: #ff6a6a; font-size: 12px; background: rgba(0,0,0,.4); padding: 3px 9px; border-radius: 10px; display: none; }
    #recDot.on { display: block; }
    #camPreview { position: absolute; right: 18px; bottom: 86px;   /* above the RAD AMS stamp in the corner */ width: 140px; height: 140px; border-radius: 50%; object-fit: cover; z-index: 8; border: 2px solid rgba(255,255,255,.5); transform: scaleX(-1); }
    #rStatus { color: #888; font-size: 11px; line-height: 1.4; margin-top: 4px; }`;
  document.head.appendChild(css);
  container.insertAdjacentHTML('beforeend', `
    <label><input type="checkbox" id="rMic" checked> ${compact ? 'mic' : 'my voice (mic)'}</label>
    <label><input type="checkbox" id="rCam"> ${compact ? 'camera' : 'my camera (small circle)'}</label>
    <label>frame <select id="rFrame"><option value="reel">reel 9:16</option><option value="full">full screen</option></select></label>
    <button id="rBtn" title="record a reel of this tab (r)">● record (r)</button>
    ${compact ? '' : '<div id="rStatus">pick this tab in Chrome’s dialog and tick “share tab audio”</div>'}`);
  document.body.insertAdjacentHTML('beforeend', `<div id="recDot">● recording · press r to stop</div><video id="camPreview" autoplay muted playsinline hidden></video>`);
  const $ = id => document.getElementById(id);
  const rec = { on: false, mr: null, chunks: [], screen: null, mic: null, cam: null, raf: null, ctx: null };
  const rStatus = t => { if ($('rStatus')) $('rStatus').textContent = t; else $('rBtn').title = t; };
  async function startRec() {
    try {
      rec.screen = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: true, preferCurrentTab: true, selfBrowserSurface: 'include' });
    } catch (e) { rStatus('capture cancelled'); return; }
    const wantMic = $('rMic').checked, wantCam = $('rCam').checked;
    try { if (wantMic) rec.mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false } }); } catch { rStatus('mic not available — recording without it'); }
    try { if (wantCam) { rec.cam = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 640, facingMode: 'user' } }); const v = $('camPreview'); v.srcObject = rec.cam; v.hidden = false; } } catch { rStatus('camera not available'); }
    // mix: tab audio + mic, the voice sitting a little above the piece, through a gentle compressor so nothing clips
    const ctx = rec.ctx = new AudioContext(), dest = ctx.createMediaStreamDestination();
    const comp = ctx.createDynamicsCompressor(); comp.threshold.value = -14; comp.knee.value = 12; comp.ratio.value = 3; comp.attack.value = 0.01; comp.release.value = 0.2; comp.connect(dest);
    if (rec.screen.getAudioTracks().length) { const t = ctx.createGain(); t.gain.value = 0.85; ctx.createMediaStreamSource(new MediaStream(rec.screen.getAudioTracks())).connect(t).connect(comp); }
    if (rec.mic) { const g = ctx.createGain(); g.gain.value = 2.4; ctx.createMediaStreamSource(rec.mic).connect(g).connect(comp); }
    // picture: draw the captured tab into a canvas (cropped to 9:16 for a reel), with the camera as a circle
    const sv = document.createElement('video'); sv.srcObject = new MediaStream(rec.screen.getVideoTracks()); sv.muted = true; await sv.play();
    const cv = document.createElement('video'); if (rec.cam) { cv.srcObject = rec.cam; cv.muted = true; await cv.play(); }
    const reel = $('rFrame').value === 'reel';
    const W = reel ? 1080 : Math.min(1920, sv.videoWidth), H = reel ? 1920 : Math.round(W * sv.videoHeight / sv.videoWidth);
    const c = document.createElement('canvas'); c.width = W; c.height = H; const g2 = c.getContext('2d');
    const draw = () => {
      if (!rec.on) return;
      rec.raf = requestAnimationFrame(draw);
      const vw = sv.videoWidth, vh = sv.videoHeight; if (!vw) return;
      // cover-crop the tab picture into the frame
      const scale = Math.max(W / vw, H / vh), dw = vw * scale, dh = vh * scale;
      g2.drawImage(sv, (W - dw) / 2, (H - dh) / 2, dw, dh);
      if (rec.cam && cv.videoWidth) {
        const r = Math.round(W * 0.11), x = W - r - 40, y = H - r - 40;
        g2.save(); g2.beginPath(); g2.arc(x, y, r, 0, Math.PI * 2); g2.clip();
        g2.translate(x + r, 0); g2.scale(-1, 1);   // mirror, like a selfie
        const s = Math.max(2 * r / cv.videoWidth, 2 * r / cv.videoHeight);
        g2.drawImage(cv, r - cv.videoWidth * s / 2, y - cv.videoHeight * s / 2, cv.videoWidth * s, cv.videoHeight * s);
        g2.restore();
        g2.strokeStyle = 'rgba(255,255,255,.7)'; g2.lineWidth = 4; g2.beginPath(); g2.arc(x, y, r, 0, Math.PI * 2); g2.stroke();
      }
    };
    const out = c.captureStream(30);
    dest.stream.getAudioTracks().forEach(t => out.addTrack(t));
    const type = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'].find(t => MediaRecorder.isTypeSupported(t));
    rec.mr = new MediaRecorder(out, { mimeType: type, videoBitsPerSecond: 12e6 });
    rec.chunks = [];
    rec.mr.ondataavailable = e => { if (e.data.size) rec.chunks.push(e.data); };
    rec.mr.onstop = () => {
      const blob = new Blob(rec.chunks, { type: 'video/webm' });
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `duality-reel-${Date.now()}.webm`; a.click();
      rStatus(`saved ${(blob.size / 1e6).toFixed(1)} MB webm to Downloads — ./reel2mp4.sh makes the mp4 for Instagram`);
    };
    rec.on = true; draw(); rec.mr.start(1000);
    rec.screen.getVideoTracks()[0].onended = stopRec;   // "stop sharing" in Chrome's bar
    $('rBtn').textContent = '■ stop (r)'; $('rBtn').classList.add('rec');
    $('recDot').classList.add('on');
    rStatus(`recording ${reel ? '1080×1920' : W + '×' + H}${rec.mic ? ' + mic' : ''}${rec.cam ? ' + camera' : ''}…`);
  }
  function stopRec() {
    if (!rec.on) return; rec.on = false;
    cancelAnimationFrame(rec.raf);
    try { rec.mr.stop(); } catch {}
    for (const st of [rec.screen, rec.mic, rec.cam]) if (st) st.getTracks().forEach(t => t.stop());
    if (rec.ctx) rec.ctx.close();
    rec.screen = rec.mic = rec.cam = null;
    const v = $('camPreview'); v.hidden = true; v.srcObject = null;
    $('rBtn').textContent = '● record (r)'; $('rBtn').classList.remove('rec');
    $('recDot').classList.remove('on');
  }
  $('rBtn').onclick = () => rec.on ? stopRec() : startRec();
  addEventListener('keydown', e => { if (e.key === 'r' && !e.metaKey && !e.ctrlKey && !['INPUT', 'SELECT'].includes(e.target.tagName)) rec.on ? stopRec() : startRec(); });
  return { start: startRec, stop: stopRec };
};
