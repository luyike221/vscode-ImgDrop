import * as vscode from 'vscode';
import { getOssAccessKeySecret } from './secrets';

export type StorageMode = 'local' | 'oss';

export interface OssSettings {
  region: string;
  bucket: string;
  accessKeyId: string;
  accessKeySecret: string;
  objectPrefix: string;
}

export function getStorageMode(config: vscode.WorkspaceConfiguration): StorageMode {
  return config.get<StorageMode>('storageMode', 'local');
}

export async function loadOssSettings(
  config: vscode.WorkspaceConfiguration,
  secrets: vscode.SecretStorage
): Promise<OssSettings | null> {
  const region = config.get<string>('oss.region', '')?.trim() ?? '';
  const bucket = config.get<string>('oss.bucket', '')?.trim() ?? '';
  const accessKeyId = config.get<string>('oss.accessKeyId', '')?.trim() ?? '';
  const accessKeySecret = (await getOssAccessKeySecret(secrets))?.trim() ?? '';
  const objectPrefix = config.get<string>('oss.objectPrefix', 'imgdrop/')?.trim() ?? '';

  if (!region || !bucket || !accessKeyId || !accessKeySecret) {
    return null;
  }

  return { region, bucket, accessKeyId, accessKeySecret, objectPrefix };
}

export function buildObjectKey(
  objectPrefix: string,
  fileName: string,
  resolveVariables: (template: string) => string
): string {
  const prefix = resolveVariables(objectPrefix);
  const normalizedPrefix = prefix.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  const key = normalizedPrefix ? `${normalizedPrefix}/${fileName}` : fileName;
  return key.replace(/\/+/g, '/');
}

export function buildPublicUrl(bucket: string, region: string, objectKey: string): string {
  const key = objectKey.replace(/^\/+/, '');
  return `https://${bucket}.${region}.aliyuncs.com/${key}`;
}

export function mimeForExtension(ext: string): string {
  switch (ext) {
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'webp':
      return 'image/webp';
    default:
      return 'image/png';
  }
}

export function ossConfigErrorHint(missing: string[]): string {
  const parts = missing.join('、');
  return `OSS 配置不完整，缺少：${parts}。请在设置中填写 region/bucket/accessKeyId，并执行命令「ImgDrop: Set OSS Access Key Secret」保存密钥。`;
}

export function listMissingOssFields(
  config: vscode.WorkspaceConfiguration,
  hasSecret: boolean
): string[] {
  const missing: string[] = [];
  if (!config.get<string>('oss.region', '')?.trim()) {
    missing.push('region');
  }
  if (!config.get<string>('oss.bucket', '')?.trim()) {
    missing.push('bucket');
  }
  if (!config.get<string>('oss.accessKeyId', '')?.trim()) {
    missing.push('accessKeyId');
  }
  if (!hasSecret) {
    missing.push('accessKeySecret（SecretStorage）');
  }
  return missing;
}
