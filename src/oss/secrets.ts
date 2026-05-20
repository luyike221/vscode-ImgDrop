import * as vscode from 'vscode';

const OSS_SECRET_KEY = 'imgDrop.oss.accessKeySecret';

export async function getOssAccessKeySecret(
  secrets: vscode.SecretStorage
): Promise<string | undefined> {
  return secrets.get(OSS_SECRET_KEY);
}

export async function setOssAccessKeySecret(
  secrets: vscode.SecretStorage,
  value: string
): Promise<void> {
  await secrets.store(OSS_SECRET_KEY, value);
}

export async function clearOssAccessKeySecret(
  secrets: vscode.SecretStorage
): Promise<void> {
  await secrets.delete(OSS_SECRET_KEY);
}
