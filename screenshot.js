const { ipcRenderer } = require('electron');

const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');
const selection = document.getElementById('selection');

let startX, startY, isDrawing = false;
let scaleX = 1;
let scaleY = 1;

ipcRenderer.on('SET_SOURCE', async (event, payload) => {
  try {
    // 新方案：主进程传的是 { imageDataURL, ... }
    if (payload && typeof payload === 'object' && payload.imageDataURL) {
      const img = new Image();
      img.onload = () => {
        const realWidth = img.naturalWidth;
        const realHeight = img.naturalHeight;

        const displayWidth = window.innerWidth;
        const displayHeight = window.innerHeight;

        scaleX = realWidth / displayWidth;
        scaleY = realHeight / displayHeight;

        canvas.width = realWidth;
        canvas.height = realHeight;

        // ✅ 用 100% 比 100vw/100vh 更不容易出现 1px 偏差
        canvas.style.width = '100vw';
        canvas.style.height = '100vh';


        // ✅ 截图要清晰：别做平滑
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(img, 0, 0, realWidth, realHeight);

        // 背景画好后再显示鼠标
        document.body.style.cursor = 'crosshair';
        ipcRenderer.send('screenshot-ready');
      };

      img.src = payload.imageDataURL;
      return;
    }

    // 旧方案兜底（可删）：如果你还传 string，就走原来的 getUserMedia
    const sourceId = payload;
    console.warn('[调试] SET_SOURCE 收到旧格式，走 getUserMedia 兜底:', sourceId);
    // （如果你决定彻底不用旧方案，这段可以直接删除）
  } catch (e) {
    console.error(e);
    ipcRenderer.send('close-screenshot');
  }
});


document.addEventListener('mousedown', (e) => {
    isDrawing = true;
    startX = e.clientX;
    startY = e.clientY;
    
    document.getElementById('bg-mask').style.display = 'none';

    selection.style.left = startX + 'px';
    selection.style.top = startY + 'px';
    selection.style.width = '0px';
    selection.style.height = '0px';
    selection.style.display = 'block';
    
    document.getElementById('size-tip').textContent = `0 x 0`;
});

document.addEventListener('mousemove', (e) => {
    // 强制保证鼠标是十字架 (防止意外情况)
    if (document.body.style.cursor !== 'crosshair') {
        document.body.style.cursor = 'crosshair';
    }

    if (!isDrawing) return;
    const currentX = e.clientX;
    const currentY = e.clientY;
    
    const width = Math.abs(currentX - startX);
    const height = Math.abs(currentY - startY);
    const left = Math.min(startX, currentX);
    const top = Math.min(startY, currentY);

    selection.style.width = width + 'px';
    selection.style.height = height + 'px';
    selection.style.left = left + 'px';
    selection.style.top = top + 'px';
    
    document.getElementById('size-tip').textContent = `${width} x ${height}`;
});

document.addEventListener('mouseup', (e) => {
    if (!isDrawing) return;
    isDrawing = false;

    const logicalW = Math.abs(e.clientX - startX);
    const logicalH = Math.abs(e.clientY - startY);
    const logicalX = Math.min(startX, e.clientX);
    const logicalY = Math.min(startY, e.clientY);

    if (logicalW < 5 || logicalH < 5) return;

    const physicalX = logicalX * scaleX;
    const physicalY = logicalY * scaleY;
    const physicalW = logicalW * scaleX;
    const physicalH = logicalH * scaleY;

    const ZOOM = 2.5; 
    const cropCanvas = document.createElement('canvas');
    cropCanvas.width = physicalW * ZOOM;
    cropCanvas.height = physicalH * ZOOM;
    const cropCtx = cropCanvas.getContext('2d');
    cropCtx.imageSmoothingEnabled = true;
    cropCtx.imageSmoothingQuality = 'high';

    cropCtx.drawImage(
        canvas, 
        physicalX, physicalY, physicalW, physicalH, 
        0, 0, cropCanvas.width, cropCanvas.height
    );

    const imageData = cropCtx.getImageData(0, 0, cropCanvas.width, cropCanvas.height);
    const data = imageData.data;
    let totalBrightness = 0;
    for (let i = 0; i < data.length; i += 40) totalBrightness += (data[i] + data[i+1] + data[i+2]) / 3;
    const isDarkMode = (totalBrightness / (data.length / 40)) < 100;

    for (let i = 0; i < data.length; i += 4) {
        let gray = 0.299 * data[i] + 0.587 * data[i+1] + 0.114 * data[i+2];
        if (isDarkMode) gray = 255 - gray; 
        gray = gray > 160 ? 255 : gray * 0.7; 
        data[i] = data[i+1] = data[i+2] = gray;
    }
    cropCtx.putImageData(imageData, 0, 0);

    const dataURL = cropCanvas.toDataURL('image/png');
    ipcRenderer.send('screenshot-captured', dataURL);
});

document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') ipcRenderer.send('close-screenshot');
});