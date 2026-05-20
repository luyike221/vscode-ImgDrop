import OSS = require('ali-oss');
import { buildPublicUrl, mimeForExtension, type OssSettings } from './config';

export async function uploadImageToOss(
  settings: OssSettings,
  objectKey: string,
  buffer: Buffer,
  ext: string
): Promise<string> {
  const client = new OSS({
    region: settings.region,
    bucket: settings.bucket,
    accessKeyId: settings.accessKeyId,
    accessKeySecret: settings.accessKeySecret,
  });

  await client.put(objectKey, buffer, {
    headers: { 'Content-Type': mimeForExtension(ext) },
  });

  return buildPublicUrl(settings.bucket, settings.region, objectKey);
}
