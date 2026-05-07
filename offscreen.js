const runningTasks = new Set();

chrome.runtime.onMessage.addListener((request,sender,sendResponse)=>{
  if (request.action!=="offscreenDownloadStream") return;

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
    await reportFailed(taskId,String(error?.message || error || 'Unknown error'));
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
  try {
    await chrome.runtime.sendMessage({
      action:'hlsTaskFailed',
      taskId:taskId,
      error:error
    });
  } catch {}
}
