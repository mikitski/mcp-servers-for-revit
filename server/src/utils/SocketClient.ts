import * as net from "net";
import { readSessionToken } from "./authToken.js";
import { isWsl } from "./windowsEnv.js";
import { sendViaWindowsRelay } from "./windowsRelay.js";

const COMMAND_TIMEOUT_MS = 120000; // 2分钟超时

export class RevitClientConnection {
  host: string;
  port: number;
  socket: net.Socket;
  isConnected: boolean = false;
  responseCallbacks: Map<string, (response: string) => void> = new Map();
  buffer: string = "";
  // WSL2's loopback forwarding is commonly Windows->WSL only in practice; a
  // WSL process connecting out to 127.0.0.1 on the Windows host can be
  // refused outright even though the same address is reachable from a native
  // Windows process. When running under WSL, relay each command through
  // powershell.exe instead of connecting directly (see windowsRelay.ts).
  private readonly useWindowsRelay: boolean;

  constructor(host: string, port: number) {
    this.host = host;
    this.port = port;
    this.useWindowsRelay = isWsl();
    this.socket = new net.Socket();

    if (this.useWindowsRelay) {
      // No persistent connection to establish - each sendCommand relays
      // through a fresh native Windows process.
      this.isConnected = true;
    } else {
      this.setupSocketListeners();
    }
  }

  private setupSocketListeners(): void {
    this.socket.on("connect", () => {
      this.isConnected = true;
    });

    this.socket.on("data", (data) => {
      // 将接收到的数据添加到缓冲区
      const dataString = data.toString();
      this.buffer += dataString;

      // 尝试解析完整的JSON响应
      this.processBuffer();
    });

    this.socket.on("close", () => {
      this.isConnected = false;
    });

    this.socket.on("error", (error) => {
      console.error("RevitClientConnection error:", error);
      this.isConnected = false;
    });
  }

  private processBuffer(): void {
    try {
      // 尝试解析JSON
      const response = JSON.parse(this.buffer);
      // 如果成功解析，处理响应并清空缓冲区
      this.handleResponse(this.buffer);
      this.buffer = "";
    } catch (e) {
      // 如果解析失败，可能是因为数据不完整，继续等待更多数据
    }
  }

  public connect(): boolean {
    if (this.useWindowsRelay || this.isConnected) {
      return true;
    }

    try {
      this.socket.connect(this.port, this.host);
      return true;
    } catch (error) {
      console.error("Failed to connect:", error);
      return false;
    }
  }

  public disconnect(): void {
    if (this.useWindowsRelay) return;
    this.socket.end();
    this.isConnected = false;
  }

  private generateRequestId(): string {
    return Date.now().toString() + Math.random().toString().substring(2, 8);
  }

  private handleResponse(responseData: string): void {
    try {
      const response = JSON.parse(responseData);
      // 从响应中获取ID
      const requestId = response.id || "default";

      const callback = this.responseCallbacks.get(requestId);
      if (callback) {
        callback(responseData);
        this.responseCallbacks.delete(requestId);
      }
    } catch (error) {
      console.error("Error parsing response:", error);
    }
  }

  private buildCommandObject(command: string, params: any) {
    return {
      jsonrpc: "2.0",
      method: command,
      params,
      id: this.generateRequestId(),
      // Echoes the per-session token the plugin generated in SocketService,
      // required since the socket has no other authentication (see the
      // security review's F1 finding).
      token: readSessionToken(),
    };
  }

  public sendCommand(command: string, params: any = {}): Promise<any> {
    return this.useWindowsRelay
      ? this.sendCommandViaRelay(command, params)
      : this.sendCommandViaSocket(command, params);
  }

  // Blocks this process while the relay runs. Acceptable here because
  // withRevitConnection() already serializes all Revit calls to one at a
  // time via its mutex, so nothing else could make progress concurrently
  // anyway; a fully async spawn would be nicer for MCP protocol
  // responsiveness but adds real complexity for little practical gain in a
  // single-user local tool.
  private async sendCommandViaRelay(command: string, params: any): Promise<any> {
    const commandObj = this.buildCommandObject(command, params);
    const responseText = sendViaWindowsRelay(
      this.host,
      this.port,
      JSON.stringify(commandObj),
      COMMAND_TIMEOUT_MS
    );

    let response: any;
    try {
      response = JSON.parse(responseText);
    } catch (error) {
      throw new Error(
        `Failed to parse response: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }

    if (response.error) {
      throw new Error(response.error.message || "Unknown error from Revit");
    }
    return response.result;
  }

  private sendCommandViaSocket(command: string, params: any = {}): Promise<any> {
    return new Promise((resolve, reject) => {
      try {
        if (!this.isConnected) {
          this.connect();
        }

        const commandObj = this.buildCommandObject(command, params);
        const requestId = commandObj.id;

        // 存储回调函数
        this.responseCallbacks.set(requestId, (responseData) => {
          try {
            const response = JSON.parse(responseData);
            if (response.error) {
              reject(
                new Error(response.error.message || "Unknown error from Revit")
              );
            } else {
              resolve(response.result);
            }
          } catch (error) {
            if (error instanceof Error) {
              reject(new Error(`Failed to parse response: ${error.message}`));
            } else {
              reject(new Error(`Failed to parse response: ${String(error)}`));
            }
          }
        });

        // 发送命令
        const commandString = JSON.stringify(commandObj);
        this.socket.write(commandString);

        // 设置超时
        setTimeout(() => {
          if (this.responseCallbacks.has(requestId)) {
            this.responseCallbacks.delete(requestId);
            reject(new Error(`Command timed out after 2 minutes: ${command}`));
          }
        }, COMMAND_TIMEOUT_MS);
      } catch (error) {
        reject(error);
      }
    });
  }
}
