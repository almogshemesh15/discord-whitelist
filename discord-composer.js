function esc(s) {
    return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
}

function registerDiscordComposer(app, deps) {
    const { checkAuth, OWNER_EMAIL, db, enqueueBotJob, safeSave, publicBaseUrl } = deps;

    function ensureComposer(data) {
        if (!Array.isArray(data.pendingBotJobs)) data.pendingBotJobs = [];
        if (!Array.isArray(data.composerDrafts)) data.composerDrafts = [];
    }

    app.get('/composer', checkAuth, (req, res) => {
        if (req.session.userEmail !== OWNER_EMAIL) return res.status(403).send('Owner only');
        res.send(`<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Message Composer</title>
<style>
body{margin:0;font-family:system-ui,sans-serif;background:#0b0f19;color:#e2e8f0}
.wrap{max-width:900px;margin:0 auto;padding:24px}
h1{color:#a78bfa;margin:0 0 8px}
a{color:#38bdf8}
.card{background:#111827;border:1px solid #1e293b;border-radius:14px;padding:18px;margin-bottom:14px}
label{display:block;font-size:12px;color:#94a3b8;margin:10px 0 4px}
input,textarea,select{width:100%;padding:10px;border-radius:8px;border:1px solid #334155;background:#0f172a;color:#fff;box-sizing:border-box}
textarea{min-height:90px;font-family:ui-monospace,monospace}
.row{display:grid;grid-template-columns:1fr 1fr;gap:12px}
button.btn{padding:10px 14px;border:0;border-radius:8px;background:#7c3aed;color:#fff;font-weight:700;cursor:pointer;margin-right:8px;margin-top:10px}
button.sec{background:#334155}button.green{background:#059669}
.muted{color:#64748b;font-size:13px}
.preview{background:#1e1f22;border-radius:8px;padding:14px;margin-top:12px;border-left:4px solid #5865f2}
.preview .emb{background:#2b2d31;border-radius:4px;padding:12px;margin-top:8px;border-left:4px solid #5865f2}
</style></head><body><div class="wrap">
<div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">
  <h1>Discord Composer</h1>
  <div><a href="/hub">Hub</a> · <a href="/bot">Bot</a> · <a href="/">Dashboard</a></div>
</div>
<p class="muted">Send or edit messages through the bot (Discohook-style). Bot must be online.</p>

<div class="card">
  <h3>Target</h3>
  <div class="row">
    <div><label>Channel ID</label><input id="channelId" placeholder="1234567890"/></div>
    <div><label>Message link (to edit existing)</label><input id="messageLink" placeholder="https://discord.com/channels/guild/channel/message"/></div>
  </div>
  <label>Mentions — user IDs and/or role IDs (comma-separated, mix OK)</label>
  <input id="mentions" placeholder="userId, roleId, @everyone (optional)"/>
  <p class="muted">Prefix roles with <code>role:</code> if needed, e.g. <code>111, role:222</code>. Plain numeric IDs are treated as users; use <code>role:ID</code> for roles. <code>@everyone</code> / <code>@here</code> allowed.</p>
</div>

<div class="card">
  <h3>Content</h3>
  <label>Message content</label>
  <textarea id="content" placeholder="Hello {{mentions}}"></textarea>
  <label>Embed title</label><input id="embTitle"/>
  <label>Embed description</label><textarea id="embDesc"></textarea>
  <div class="row">
    <div><label>Embed color (hex)</label><input id="embColor" value="#5865F2"/></div>
    <div><label>Embed footer</label><input id="embFooter"/></div>
  </div>
  <label>Embed image URL</label><input id="embImage"/>
  <label>Embed thumbnail URL</label><input id="embThumb"/>
  <button type="button" class="btn green" id="btnSend">Send new message</button>
  <button type="button" class="btn" id="btnEdit">Edit message from link</button>
  <button type="button" class="btn sec" id="btnPreview">Refresh preview</button>
  <div id="status" class="muted" style="margin-top:10px"></div>
  <div class="preview" id="preview"></div>
</div>

<script>
function parseMentions(raw){
  const parts = String(raw||'').split(/[\\s,]+/).map(s=>s.trim()).filter(Boolean);
  const users=[], roles=[];
  let everyone=false, here=false;
  for(const p of parts){
    const low=p.toLowerCase();
    if(low==='@everyone'||low==='everyone'){everyone=true;continue;}
    if(low==='@here'||low==='here'){here=true;continue;}
    if(/^role:/i.test(p)){roles.push(p.replace(/^role:/i,'').replace(/\\D/g,''));continue;}
    if(/^<@&(\\d+)>$/.test(p)){roles.push(p.replace(/\\D/g,''));continue;}
    if(/^<@!?(\\d+)>$/.test(p)){users.push(p.replace(/\\D/g,''));continue;}
    if(/^\\d+$/.test(p)) users.push(p);
  }
  return {users,roles,everyone,here};
}
function buildMentionPrefix(m){
  const bits=[];
  if(m.everyone) bits.push('@everyone');
  if(m.here) bits.push('@here');
  m.roles.forEach(id=>bits.push('<@&'+id+'>'));
  m.users.forEach(id=>bits.push('<@'+id+'>'));
  return bits.join(' ');
}
function payload(){
  const mentions=parseMentions(document.getElementById('mentions').value);
  const prefix=buildMentionPrefix(mentions);
  let content=document.getElementById('content').value||'';
  if(prefix) content=(prefix+(content?' '+content:'')).trim();
  const colorRaw=(document.getElementById('embColor').value||'#5865F2').replace('#','');
  const color=parseInt(colorRaw,16);
  const embed={};
  const title=document.getElementById('embTitle').value.trim();
  const desc=document.getElementById('embDesc').value.trim();
  const footer=document.getElementById('embFooter').value.trim();
  const image=document.getElementById('embImage').value.trim();
  const thumb=document.getElementById('embThumb').value.trim();
  if(title) embed.title=title;
  if(desc) embed.description=desc;
  if(!isNaN(color)) embed.color=color;
  if(footer) embed.footer={text:footer};
  if(image) embed.image={url:image};
  if(thumb) embed.thumbnail={url:thumb};
  const embeds=(title||desc||image||thumb||footer)?[embed]:[];
  return {
    channelId:document.getElementById('channelId').value.trim(),
    messageLink:document.getElementById('messageLink').value.trim(),
    content,
    embeds,
    allowedMentions:{
      parse: [mentions.everyone&&'everyone',mentions.here&&'here'].filter(Boolean),
      users: mentions.users,
      roles: mentions.roles
    }
  };
}
function renderPreview(){
  const p=payload();
  let html='<div>'+ (p.content?p.content.replace(/</g,'&lt;'):'<span class="muted">(no content)</span>') +'</div>';
  (p.embeds||[]).forEach(e=>{
    html+='<div class="emb" style="border-left-color:#'+(e.color!=null?e.color.toString(16).padStart(6,'0'):'5865f2')+'">';
    if(e.title) html+='<div style="font-weight:700">'+e.title.replace(/</g,'&lt;')+'</div>';
    if(e.description) html+='<div style="margin-top:6px;white-space:pre-wrap">'+e.description.replace(/</g,'&lt;')+'</div>';
    if(e.footer&&e.footer.text) html+='<div class="muted" style="margin-top:8px">'+e.footer.text.replace(/</g,'&lt;')+'</div>';
    html+='</div>';
  });
  document.getElementById('preview').innerHTML=html;
}
document.getElementById('btnPreview').onclick=renderPreview;
['content','embTitle','embDesc','embColor','embFooter','mentions'].forEach(id=>{
  const el=document.getElementById(id); if(el) el.addEventListener('input',renderPreview);
});
async function post(path,body){
  const r=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const j=await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(j.error||('HTTP '+r.status));
  return j;
}
document.getElementById('btnSend').onclick=async()=>{
  const st=document.getElementById('status');
  try{
    const p=payload();
    if(!p.channelId) throw new Error('Channel ID required');
    if(!p.content && !(p.embeds&&p.embeds.length)) throw new Error('Content or embed required');
    st.textContent='Queuing send…';
    await post('/api/composer/send',p);
    st.textContent='Queued. Bot will send when online (usually a few seconds).';
  }catch(e){st.textContent=e.message||e;}
};
document.getElementById('btnEdit').onclick=async()=>{
  const st=document.getElementById('status');
  try{
    const p=payload();
    if(!p.messageLink) throw new Error('Message link required to edit');
    st.textContent='Queuing edit…';
    await post('/api/composer/edit',p);
    st.textContent='Queued. Bot will edit when online.';
  }catch(e){st.textContent=e.message||e;}
};
renderPreview();
</script>
</div></body></html>`);
    });

    app.post('/api/composer/send', checkAuth, async (req, res) => {
        if (req.session.userEmail !== OWNER_EMAIL) return res.status(403).json({ error: 'owner only' });
        const data = db.getData();
        ensureComposer(data);
        const channelId = String(req.body.channelId || '').trim();
        if (!/^\d+$/.test(channelId)) return res.status(400).json({ error: 'Valid channelId required' });
        const content = String(req.body.content || '');
        const embeds = Array.isArray(req.body.embeds) ? req.body.embeds : [];
        if (!content && !embeds.length) return res.status(400).json({ error: 'content or embeds required' });
        enqueueBotJob(data, 'discord_message_send', {
            channelId,
            content,
            embeds,
            allowedMentions: req.body.allowedMentions || { parse: [] }
        });
        await safeSave();
        res.json({ ok: true });
    });

    app.post('/api/composer/edit', checkAuth, async (req, res) => {
        if (req.session.userEmail !== OWNER_EMAIL) return res.status(403).json({ error: 'owner only' });
        const data = db.getData();
        ensureComposer(data);
        const link = String(req.body.messageLink || '').trim();
        // https://discord.com/channels/GUILD/CHANNEL/MESSAGE
        const m = link.match(/channels\/(\d+)\/(\d+)\/(\d+)/);
        if (!m) return res.status(400).json({ error: 'Invalid message link' });
        const channelId = m[2];
        const messageId = m[3];
        const content = String(req.body.content || '');
        const embeds = Array.isArray(req.body.embeds) ? req.body.embeds : [];
        enqueueBotJob(data, 'discord_message_edit', {
            channelId,
            messageId,
            content,
            embeds,
            allowedMentions: req.body.allowedMentions || { parse: [] }
        });
        await safeSave();
        res.json({ ok: true, channelId, messageId });
    });
}

module.exports = { registerDiscordComposer };
