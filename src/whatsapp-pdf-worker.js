'use strict';

const { parentPort, workerData } = require('node:worker_threads');
(async () => {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = getDocument({ data:new Uint8Array(workerData), isEvalSupported:false,
    useSystemFonts:false, disableFontFace:true, verbosity:0 });
  let pdf;
  try {
    pdf = await task.promise;
    if (pdf.numPages > 20) throw new Error('too_many_pages');
    let text = '';
    for (let n=1;n<=pdf.numPages;n++) {
      const page=await pdf.getPage(n), content=await page.getTextContent();
      let line='', y=null;
      for (const item of content.items) {
        if (typeof item.str !== 'string') continue;
        const nextY=item.transform?.[5];
        if (y!==null && nextY!==undefined && Math.abs(nextY-y)>3 && line) {text+=line+'\n';line='';}
        line+=(line?' ':'')+item.str;y=nextY;
        if (item.hasEOL) {text+=line+'\n';line='';y=null;}
      }
      text+=line+'\n';page.cleanup();
      if (text.length>50000) throw new Error('too_much_text');
    }
    parentPort.postMessage({text});
  } catch (error) {
    parentPort.postMessage({error:error.name==='PasswordException'?'encrypted_pdf':
      ['too_many_pages','too_much_text'].includes(error.message)?error.message:'unreadable_pdf'});
  } finally {await task.destroy();}
})().catch(()=>parentPort.postMessage({error:'unreadable_pdf'}));
