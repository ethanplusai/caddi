// Isolated local canvas: fixed host script, validated image bytes/numeric marks only.
import { randomUUID } from 'node:crypto';
import { CaddiError } from '../contracts.mjs';

const page = '<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data:; script-src \'none\'; connect-src \'none\'; frame-src \'none\'; object-src \'none\'; base-uri \'none\'; form-action \'none\'"><title>Local evidence raster</title><canvas></canvas>';
const script = async input => {
  const canvas = document.querySelector('canvas'), ctx = canvas.getContext('2d', {willReadFrequently:false});
  const image = async (base64, mediaType) => {
    const value = new Image(); value.src = 'data:' + mediaType + ';base64,' + base64;
    await value.decode(); return value;
  };
  if (input.type === 'frame') {
    canvas.width = input.width; canvas.height = input.height;
    const source = await image(input.source, input.mediaType);
    if (source.naturalWidth !== input.width || source.naturalHeight !== input.height) throw new Error('Decoded image dimensions changed');
    ctx.drawImage(source, 0, 0); source.removeAttribute('src');
    const colors = {teal:'#246b59',coral:'#b04f43',gold:'#95702a'};
    const weight = Math.max(3, Math.min(16, Math.round(Math.min(canvas.width,canvas.height)/180)));
    ctx.lineWidth = weight; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    for (const mark of input.marks) {
      ctx.strokeStyle = colors[mark.color];
      if (mark.kind === 'rectangle') {
        ctx.strokeRect(mark.x*canvas.width,mark.y*canvas.height,mark.width*canvas.width,mark.height*canvas.height);
      } else {
        const x=mark.x*canvas.width,y=mark.y*canvas.height,x2=mark.x2*canvas.width,y2=mark.y2*canvas.height;
        const angle=Math.atan2(y2-y,x2-x),head=Math.max(weight*3,Math.min(canvas.width,canvas.height)/28);
        ctx.beginPath();ctx.moveTo(x,y);ctx.lineTo(x2,y2);
        for(const offset of [-0.55,0.55]) {ctx.moveTo(x2,y2);ctx.lineTo(x2-head*Math.cos(angle+offset),y2-head*Math.sin(angle+offset));}
        ctx.stroke();
      }
    }
  } else if (input.type === 'sheet') {
    const cellW=500,cellH=360,gap=12,cols=Math.min(2,input.frames.length),rows=Math.ceil(input.frames.length/cols);
    canvas.width=cols*cellW+(cols+1)*gap;canvas.height=rows*cellH+(rows+1)*gap;
    ctx.fillStyle='#f4f6f2';ctx.fillRect(0,0,canvas.width,canvas.height);
    for (const [index,frame] of input.frames.entries()) {
      const x=gap+(index%cols)*(cellW+gap),y=gap+Math.floor(index/cols)*(cellH+gap);
      ctx.fillStyle='#ffffff';ctx.fillRect(x,y,cellW,cellH);
      const shot=await image(frame.base64,'image/png');
      const scale=Math.min((cellW-20)/shot.naturalWidth,(cellH-48)/shot.naturalHeight);
      const width=shot.naturalWidth*scale,height=shot.naturalHeight*scale;
      ctx.drawImage(shot,x+(cellW-width)/2,y+33+(cellH-43-height)/2,width,height);shot.removeAttribute('src');
      ctx.fillStyle='#20352f';ctx.font='bold 15px system-ui,sans-serif';ctx.fillText('Moment '+frame.index+' · '+frame.atMs+' ms',x+12,y+22,cellW-24);
    }
  } else throw new Error('Unknown local raster operation');
  const result = canvas.toDataURL('image/png').split(',')[1];
  ctx.clearRect(0,0,canvas.width,canvas.height);canvas.width=0;canvas.height=0;
  return result;
};
export function createEvidenceRasterizer({ BrowserWindow }) {
  if (typeof BrowserWindow !== 'function') throw new CaddiError('INTEGRATION_REQUIRED','Native canvas is unavailable');
  return async input => {
    const window = new BrowserWindow({show:false,width:1,height:1,paintWhenInitiallyHidden:true,
      webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,webSecurity:true,
        partition:'m2-evidence-'+randomUUID(),backgroundThrottling:false}});
    try {
      window.webContents.setWindowOpenHandler(() => ({action:'deny'}));
      window.webContents.on('will-navigate',event=>event.preventDefault());
      window.webContents.session.setPermissionRequestHandler((_webContents,_permission,callback)=>callback(false));
      window.webContents.session.webRequest.onBeforeRequest((details,callback)=>callback({cancel:!details.url.startsWith('data:')}));
      await window.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent(page));
      let timer;
      const result = await Promise.race([window.webContents.executeJavaScript('('+script.toString()+')('+JSON.stringify(input)+')',true),
        new Promise((_,reject)=>{timer=setTimeout(()=>reject(new CaddiError('PREPARE_TIMEOUT','Local image preparation timed out')),8000);})]).finally(()=>clearTimeout(timer));
      if (typeof result !== 'string' || result.length > 1_400_000) throw new CaddiError('PREPARE_SIZE','Prepared image is too large');
      return result;
    } finally { if (!window.isDestroyed()) window.destroy(); }
  };
}
