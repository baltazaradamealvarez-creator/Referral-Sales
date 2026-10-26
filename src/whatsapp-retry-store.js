'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

// Only outgoing message bodies are retained, so WhatsApp can resend the same
// message ID after a recipient reports a decryption failure. Nothing is replayed
// on startup. The bounded cache and its key live beside the linked-device keys.
function createRetryStore(authDir, { codec, normalizeJid, allowRetry = () => true, onDiagnostic = () => {},
  now = Date.now, limit = 500, ttlMs = 7 * 86400000 } = {}) {
  const file=path.join(authDir,'message-retry.enc'),keyFile=path.join(authDir,'message-retry.key');
  const maxBytes=8*1024*1024;
  const records=new Map();let encryptionKey;
  const report=kind=>{try{onDiagnostic({kind});}catch{}};
  function key() {
    if(encryptionKey)return encryptionKey;
    fs.mkdirSync(authDir,{recursive:true,mode:0o700});
    if(!fs.existsSync(keyFile)) {
      try{fs.writeFileSync(keyFile,crypto.randomBytes(32),{mode:0o600,flag:'wx'});}catch(e){if(e.code!=='EEXIST')throw e;}
    }
    const saved=fs.readFileSync(keyFile);
    if(saved.length!==32)throw new Error('Invalid retry-cache key');
    encryptionKey=saved;return saved;
  }
  function prune() {
    for(const [id,r] of records)if(!Number.isFinite(r.at) || r.at<now()-ttlMs)records.delete(id);
    let bytes=2+[...records.values()].reduce((total,r)=>total+Buffer.byteLength(JSON.stringify(r))+1,0);
    while(records.size && (records.size>limit || bytes>maxBytes-32)) {
      const id=records.keys().next().value;bytes-=Buffer.byteLength(JSON.stringify(records.get(id)))+1;records.delete(id);
    }
  }
  function persist() {
    const iv=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',key(),iv);
    const encrypted=Buffer.concat([cipher.update(JSON.stringify([...records.values()])),cipher.final()]);
    const tmp=path.join(authDir,`message-retry-${crypto.randomUUID()}.tmp`);
    try{
      fs.writeFileSync(tmp,Buffer.concat([Buffer.from('WAR1'),iv,cipher.getAuthTag(),encrypted]),{mode:0o600});
      fs.renameSync(tmp,file);
    }finally{fs.rmSync(tmp,{force:true});}
  }
  try {
    if(fs.existsSync(file)) {
      if(fs.statSync(file).size>maxBytes || !fs.existsSync(keyFile))throw new Error('Retry cache unavailable');
      const encrypted=fs.readFileSync(file);
      if(encrypted.length<32 || encrypted.subarray(0,4).toString()!=='WAR1')throw new Error('Invalid retry cache');
      const decipher=crypto.createDecipheriv('aes-256-gcm',key(),encrypted.subarray(4,16));decipher.setAuthTag(encrypted.subarray(16,32));
      const saved=JSON.parse(Buffer.concat([decipher.update(encrypted.subarray(32)),decipher.final()]).toString());
      if(!Array.isArray(saved))throw new Error('Invalid retry cache');
      for(const r of saved)if(r && typeof r.id==='string' && typeof r.chat==='string' && typeof r.body==='string')records.set(r.id,r);
      const count=records.size;prune();if(count!==records.size)persist();
    }
  }catch{records.clear();report('retry_cache_error');}
  return {
    put(sent,chat,{kind='chat',quiet=false,aliases=[]}={}) {
      if(!sent?.key?.id || !sent.message)return;
      try{
        const id=sent.key.id;
        const body=Buffer.from(codec.encode(sent.message).finish()).toString('base64');
        const peers=[...new Set([chat,sent.key.remoteJid,...aliases].filter(Boolean).map(normalizeJid))];
        records.delete(id);records.set(id,{id,chat:normalizeJid(chat),aliases:peers,kind,quiet:!!quiet,at:now(),body});
        prune();persist();
      }catch{report('retry_cache_error');}
    },
    get(messageKey, extraAliases=[]) {
      report('retry_request');prune();
      const r=records.get(messageKey?.id),peer=normalizeJid(messageKey?.remoteJid || '');
      if(!r){report('retry_missing');return undefined;}
      const peers=[r.chat,...(Array.isArray(r.aliases)?r.aliases:[])],extra=extraAliases.map(normalizeJid);
      const sameChat=peers.includes(peer) || (extra.includes(peer) && extra.some(alias=>peers.includes(alias)));
      if(!peer || !sameChat || !allowRetry(r)){report('retry_blocked');return undefined;}
      try{const message=codec.decode(Buffer.from(r.body,'base64'));report('retry_available');return message;}
      catch{report('retry_cache_error');report('retry_missing');return undefined;}
    },
  };
}

module.exports = { createRetryStore };
