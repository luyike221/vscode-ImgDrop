declare module 'ali-oss' {
  interface OssClientOptions {
    region: string;
    bucket: string;
    accessKeyId: string;
    accessKeySecret: string;
  }

  interface PutOptions {
    headers?: Record<string, string>;
  }

  interface PutResult {
    name: string;
    url: string;
    res: unknown;
  }

  class OSS {
    constructor(options: OssClientOptions);
    put(name: string, file: Buffer, options?: PutOptions): Promise<PutResult>;
  }

  export = OSS;
}
