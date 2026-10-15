import { createHash } from 'node:crypto';
import { CHAT_LIMITS } from './config.mjs';
import { documentName } from './documents.mjs';

export const imageLimitMb=Math.round(CHAT_LIMITS.imageBytes/1048576);
export const IMAGE_FORMATS={'image/png':'PNG','image/jpeg':'JPEG','image/gif':'GIF','image/webp':'WebP'};
const unsupported='Attach a PNG, JPEG, GIF or WebP image. For a PDF or other document, use Attach document.';
// The image's own bytes decide its type; a declared Content-Type or file extension does not.
export function imageType(buffer){
  if(!buffer||buffer.length<12)return '';
  if(buffer.subarray(0,8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a])))return 'image/png';
  if(buffer[0]===0xff&&buffer[1]===0xd8&&buffer[2]===0xff)return 'image/jpeg';
  const head=buffer.subarray(0,6).toString('latin1');if(head==='GIF87a'||head==='GIF89a')return 'image/gif';
  if(buffer.subarray(0,4).toString('latin1')==='RIFF'&&buffer.subarray(8,12).toString('latin1')==='WEBP')return 'image/webp';
  return '';
}
// The EXIF orientation of a JPEG (1 when absent or unreadable), so a phone photo is stored
// the way up it was taken. Only the APP1 segment's first IFD is read.
export function exifOrientation(buffer){
  if(imageType(buffer)!=='image/jpeg')return 1;
  let offset=2;
  while(offset+4<=buffer.length){
    if(buffer[offset]!==0xff)return 1;
    const marker=buffer[offset+1];
    if(marker===0xff){offset++;continue;}
    if(marker===0x01||marker>=0xd0&&marker<=0xd8){offset+=2;continue;}
    if(marker===0xd9||marker===0xda)return 1;
    const size=buffer.readUInt16BE(offset+2);if(size<2)return 1;
    if(marker===0xe1&&buffer.subarray(offset+4,offset+10).toString('latin1')==='Exif\0\0'){
      const tiff=offset+10;if(tiff+8>buffer.length)return 1;
      const order=buffer.subarray(tiff,tiff+2).toString('latin1');if(order!=='II'&&order!=='MM')return 1;
      const u16=at=>order==='II'?buffer.readUInt16LE(at):buffer.readUInt16BE(at),u32=at=>order==='II'?buffer.readUInt32LE(at):buffer.readUInt32BE(at);
      if(u16(tiff+2)!==42)return 1;
      const ifd=tiff+u32(tiff+4);if(ifd+2>buffer.length)return 1;
      const entries=u16(ifd);
      for(let i=0;i<entries;i++){const entry=ifd+2+i*12;if(entry+12>buffer.length)return 1;if(u16(entry)===0x0112){const value=u16(entry+8);return value>=1&&value<=8?value:1;}}
      return 1;
    }
    offset+=2+size;
  }
  return 1;
}
// An image the user attaches to a chat message. It is decoded on this computer, scaled to the
// size the model would see anyway (at most imageEdge pixels on the long side and about
// imagePixels pixels in all), kept the way up its EXIF orientation says, and re-encoded without
// any metadata, so a photo's location, camera and date tags never leave this computer. The
// stored bytes are what the message sends; their hash is the image's identity in the project.
export async function addChatImage(store,projectId,{name,type='',buffer}){
  if(!store.project(projectId))throw new Error('Project not found.');
  if(!buffer?.length)throw new Error('Choose an image to attach.');
  if(buffer.length>CHAT_LIMITS.imageBytes)throw new Error(`Attach an image of ${imageLimitMb} MB or less.`);
  const detected=imageType(buffer);if(!detected)throw new Error(unsupported);
  const {createCanvas,loadImage}=await import('@napi-rs/canvas');
  let image;try{image=await loadImage(buffer);}catch{throw new Error('This image could not be read. Save it as PNG or JPEG and try again.');}
  const sw=Number(image.width),sh=Number(image.height);
  if(!(sw>0&&sh>0))throw new Error('This image could not be read. Save it as PNG or JPEG and try again.');
  const scale=Math.min(1,CHAT_LIMITS.imageEdge/Math.max(sw,sh),Math.sqrt(CHAT_LIMITS.imagePixels/(sw*sh)));
  const w=Math.max(1,Math.round(sw*scale)),h=Math.max(1,Math.round(sh*scale)),orientation=exifOrientation(buffer);
  // The decoder already applies a JPEG's EXIF orientation: image.width and image.height are the
  // upright size, so a phone photo is drawn the way up it was taken.
  const draw=background=>{
    const canvas=createCanvas(w,h),ctx=canvas.getContext('2d');
    if(background){ctx.fillStyle=background;ctx.fillRect(0,0,w,h);}
    ctx.drawImage(image,0,0,w,h);
    return canvas;
  };
  let mediaType=detected==='image/jpeg'?'image/jpeg':detected==='image/webp'?'image/webp':'image/png',canvas=draw(null);
  let bytes=mediaType==='image/png'?canvas.toBuffer('image/png'):canvas.toBuffer(mediaType,90);
  // A lossless image too large to send is flattened to JPEG; a photo's own format is already compact.
  if(bytes.length>CHAT_LIMITS.imageStoredBytes&&mediaType!=='image/jpeg'){mediaType='image/jpeg';canvas=draw('#ffffff');bytes=canvas.toBuffer('image/jpeg',85);}
  if(bytes.length>CHAT_LIMITS.imageStoredBytes)throw new Error('This image is too large to send even after resizing. Crop it to the part that matters and try again.');
  const id=createHash('sha256').update(bytes).digest('hex').slice(0,16);
  const saved=store.addChatImage(projectId,{id,name:documentName(name),mediaType,width:canvas.width,height:canvas.height,bytes});
  store.diagnostic('chat.image_added',{projectId,format:IMAGE_FORMATS[detected],bytes:buffer.length,storedBytes:bytes.length,width:canvas.width,height:canvas.height,orientation});
  return saved;
}
