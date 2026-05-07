const runningTasks = new Set();
let ffmpegInstance = null;
let ffmpegLoadPromise = null;

chrome.runtime.onMessage.addListener((request,sender,sendResponse)=>{
  if (request.action==="offscreenDownloadStream") {
    const taskId = request.taskId;
    if (!taskId) {
      sendResponse({accepted:false,error:'taskId is required'});
      return true;
    }

    if (runningTasks.has(taskId)) {
      sendResponse({accepted:false,error:'Task already running'});
      return true;
    }

    runningTasks.add(taskId);
    sendResponse({accepted:true,taskId});

    runTask(request).finally(()=>{
      runningTasks.delete(taskId);
    });
    return true;
  }

  if (request.action==="offscreenConvertTsToMp4") {
    (async()=>{
      try {
        const mp4Buffer = await convertTsToMp4Buffer(request.tsBuffer);
        sendResponse({success:true,mp4Buffer});
      } catch (error) {
        sendResponse({success:false,error:String(error?.message || error || 'Conversion failed')});
      }
    })();
    return true;
  }
});

async function runTask(request){
  const taskId=request.taskId;
  const streamType=String(request.streamType||'hls').toLowerCase();
  const manifestUrl=request.manifestUrl;
  const variantUrl=request.variantUrl;
  const filename=request.filename;
  const hlsConcurrency=Number(request.hlsConcurrency);

  if (!filename) {
    await reportFailed(taskId,'filename is required');
    return;
  }

  try {
    let blob;
    let lastTotal=0;
    if (streamType==='dash') {
      if (!manifestUrl) {
        await reportFailed(taskId,'manifestUrl is required for DASH');
        return;
      }
      blob=await downloadDASH(manifestUrl,(current,total,status)=>{
        if (Number.isFinite(Number(total)) && Number(total)>=0) lastTotal=Number(total);
        reportProgress(taskId,current,total,status||'Downloading DASH');
      });
    } else {
      if (!variantUrl) {
        await reportFailed(taskId,'variantUrl is required for HLS');
        return;
      }
      blob=await downloadHLSWithQuality(variantUrl,(current,total,status)=>{
        if (Number.isFinite(Number(total)) && Number(total)>=0) lastTotal=Number(total);
        reportProgress(taskId,current,total,status||'Downloading segments');
      },{
        hlsConcurrency:Number.isFinite(hlsConcurrency)?hlsConcurrency:undefined
      });
    }

    const blobUrl=URL.createObjectURL(blob);
    try{
      await chrome.downloads.download({
        url:blobUrl,
        filename:filename,
        saveAs:Boolean(request.saveAs)
      });
    }finally{
      setTimeout(()=>URL.revokeObjectURL(blobUrl),60_000);
    }

    await chrome.runtime.sendMessage({
      action:'hlsTaskComplete',
      taskId:taskId,
      totalSegments:lastTotal,
      statusText:'Saved to Downloads'
    });
  } catch (error) {
    await reportFailed(taskId,error);
  }
}

async function reportProgress(taskId,current,total,status){
  try {
    await chrome.runtime.sendMessage({
      action:'hlsTaskProgress',
      taskId:taskId,
      current:current,
      total:total,
      status:status
    });
  } catch {}
}

async function reportFailed(taskId,error){
  const errorCode = typeof error?.code === 'string' ? error.code : null;
  const errorMessage = String(error?.message || error || 'Unknown error');

  try {
    await chrome.runtime.sendMessage({
      action:'hlsTaskFailed',
      taskId:taskId,
      error:errorMessage,
      errorCode:errorCode
    });
  } catch {}
}

async function ensureFfmpegLoaded(){
  if (ffmpegInstance?.loaded) {
    return ffmpegInstance;
  }

  if (!ffmpegLoadPromise) {
    ffmpegLoadPromise=(async()=>{
      if (!globalThis.FFmpegWASM?.FFmpeg) {
        throw new Error('ffmpeg.wasm runtime is not available');
      }
      const ffmpeg = new globalThis.FFmpegWASM.FFmpeg();
      await ffmpeg.load({
        coreURL: chrome.runtime.getURL('node_modules/@ffmpeg/core/dist/esm/ffmpeg-core.js'),
        wasmURL: chrome.runtime.getURL('node_modules/@ffmpeg/core/dist/esm/ffmpeg-core.wasm')
      });
      ffmpegInstance = ffmpeg;
      return ffmpeg;
    })().catch((error)=>{
      ffmpegLoadPromise = null;
      throw error;
    });
  }

  return ffmpegLoadPromise;
}

async function convertTsToMp4Buffer(tsBuffer){
  if (!(tsBuffer instanceof ArrayBuffer)) {
    throw new Error('Missing TS data buffer');
  }

  const ffmpeg = await ensureFfmpegLoaded();
  const inputFile=`input-${Date.now()}.ts`;
  const outputFile=`output-${Date.now()}.mp4`;

  try {
    await ffmpeg.writeFile(inputFile,new Uint8Array(tsBuffer));
    await ffmpeg.exec(['-i',inputFile,'-c','copy',outputFile]);
    const outputData = await ffmpeg.readFile(outputFile);
    if (!(outputData instanceof Uint8Array) || outputData.length===0) {
      throw new Error('ffmpeg produced empty output');
    }
    return outputData.buffer.slice(outputData.byteOffset,outputData.byteOffset + outputData.byteLength);
  } finally {
    try { await ffmpeg.deleteFile(inputFile); } catch {}
    try { await ffmpeg.deleteFile(outputFile); } catch {}
  }
}
