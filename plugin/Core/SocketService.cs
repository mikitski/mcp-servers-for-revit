using System;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using Autodesk.Revit.UI;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Models.JsonRPC;
using RevitMCPSDK.API.Interfaces;
using revit_mcp_plugin.Configuration;
using revit_mcp_plugin.Utils;

namespace revit_mcp_plugin.Core
{
    public class SocketService
    {
        private static SocketService _instance;
        private TcpListener _listener;
        private Thread _listenerThread;
        private bool _isRunning;
        private int _port = 8080;
        private UIApplication _uiApp;
        private ICommandRegistry _commandRegistry;
        private ILogger _logger;
        private CommandExecutor _commandExecutor;
        private string _authToken;

        // JSON-RPC reserves -32768..-32000 for predefined errors; this is an
        // implementation-defined server error in that range.
        private const int UnauthorizedErrorCode = -32001;

        public static SocketService Instance
        {
            get
            {
                if(_instance == null)
                    _instance = new SocketService();
                return _instance;
            }
        }

        private SocketService()
        {
            _commandRegistry = new RevitCommandRegistry();
            _logger = new Logger();
        }

        public bool IsRunning => _isRunning;

        public int Port
        {
            get => _port;
            set => _port = value;
        }

        // 初始化
        // Initialization.
        public void Initialize(UIApplication uiApp)
        {
            _uiApp = uiApp;

            // 初始化事件管理器
            // Initialize ExternalEventManager
            ExternalEventManager.Instance.Initialize(uiApp, _logger);

            // 记录当前 Revit 版本
            // Get the current Revit version.
            var versionAdapter = new RevitMCPSDK.API.Utils.RevitVersionAdapter(_uiApp.Application);
            string currentVersion = versionAdapter.GetRevitVersion();
            _logger.Info("当前 Revit 版本: {0}\nCurrent Revit version: {0}", currentVersion);



            // 创建命令执行器
            // Create CommandExecutor
            _commandExecutor = new CommandExecutor(_commandRegistry, _logger);

            // 加载配置并注册命令
            // Load configuration and register commands.
            ConfigurationManager configManager = new ConfigurationManager(_logger);
            configManager.LoadConfiguration();
            

            //// 从配置中读取服务端口
            //// Read the service port from the configuration.
            //if (configManager.Config.Settings.Port > 0)
            //{
            //    _port = configManager.Config.Settings.Port;
            //}
            _port = 8080; // 固定端口号 - Hard-wired port number.

            // 加载命令
            // Load command.
            CommandManager commandManager = new CommandManager(
                _commandRegistry, _logger, configManager, _uiApp);
            commandManager.LoadCommands();

            // 生成本次会话的认证令牌，并写入供 MCP 服务器读取
            // Generate this session's auth token and persist it for the MCP server to read.
            _authToken = GenerateAuthToken();
            PersistAuthToken(_authToken);

            _logger.Info($"Socket service initialized on port {_port}");
        }

        private static string GenerateAuthToken()
        {
            byte[] bytes = new byte[32];
            using (var rng = RandomNumberGenerator.Create())
            {
                rng.GetBytes(bytes);
            }
            return Convert.ToBase64String(bytes);
        }

        private void PersistAuthToken(string token)
        {
            try
            {
                File.WriteAllText(PathManager.GetAuthTokenFilePath(), token);
            }
            catch (Exception ex)
            {
                _logger.Error("无法写入会话令牌文件: {0}\nFailed to write session token file: {0}", ex.Message);
            }
        }

        /// <summary>
        /// Constant-time comparison so a mismatched token doesn't leak timing information.
        /// </summary>
        private bool IsTokenValid(string providedToken)
        {
            if (string.IsNullOrEmpty(_authToken) || string.IsNullOrEmpty(providedToken))
                return false;

            byte[] expected = Encoding.UTF8.GetBytes(_authToken);
            byte[] actual = Encoding.UTF8.GetBytes(providedToken);

            if (expected.Length != actual.Length)
                return false;

            int diff = 0;
            for (int i = 0; i < expected.Length; i++)
            {
                diff |= expected[i] ^ actual[i];
            }
            return diff == 0;
        }

        public void Start()
        {
            if (_isRunning) return;

            try
            {
                _isRunning = true;
                // Bind loopback only: this channel has no transport-level auth beyond the
                // per-session token, so it must never be reachable from the network.
                _listener = new TcpListener(IPAddress.Loopback, _port);
                _listener.Start();

                _listenerThread = new Thread(ListenForClients)
                {
                    IsBackground = true
                };
                _listenerThread.Start();              
            }
            catch (Exception)
            {
                _isRunning = false;
            }
        }

        public void Stop()
        {
            if (!_isRunning) return;

            try
            {
                _isRunning = false;

                _listener?.Stop();
                _listener = null;

                if(_listenerThread!=null && _listenerThread.IsAlive)
                {
                    _listenerThread.Join(1000);
                }
            }
            catch (Exception)
            {
                // log error
            }
        }

        private void ListenForClients()
        {
            try
            {
                while (_isRunning)
                {
                    TcpClient client = _listener.AcceptTcpClient();

                    Thread clientThread = new Thread(HandleClientCommunication)
                    {
                        IsBackground = true
                    };
                    clientThread.Start(client);
                }
            }
            catch (SocketException)
            {
                
            }
            catch(Exception)
            {
                // log
            }
        }

        private void HandleClientCommunication(object clientObj)
        {
            TcpClient tcpClient = (TcpClient)clientObj;
            NetworkStream stream = tcpClient.GetStream();

            try
            {
                byte[] buffer = new byte[8192];

                while (_isRunning && tcpClient.Connected)
                {
                    // 读取客户端消息
                    // Read client messages.
                    int bytesRead = 0;

                    try
                    {
                        bytesRead = stream.Read(buffer, 0, buffer.Length);
                    }
                    catch (IOException)
                    {
                        // 客户端断开连接
                        // Client disconnected.
                        break;
                    }

                    if (bytesRead == 0)
                    {
                        // 客户端断开连接
                        // Client disconnected.
                        break;
                    }

                    string message = Encoding.UTF8.GetString(buffer, 0, bytesRead);
                    System.Diagnostics.Trace.WriteLine($"收到消息: {message}\nReceived message: {message}");

                    string response = ProcessJsonRPCRequest(message);

                    // 发送响应
                    // Send response.
                    byte[] responseData = Encoding.UTF8.GetBytes(response);
                    stream.Write(responseData, 0, responseData.Length);
                }
            }
            catch(Exception)
            {
                // log
            }
            finally
            {
                tcpClient.Close();
            }
        }

        private string ProcessJsonRPCRequest(string requestJson)
        {
            JObject rawRequest;

            try
            {
                rawRequest = JObject.Parse(requestJson);
            }
            catch (JsonException)
            {
                // JSON解析错误
                // JSON parsing error.
                return CreateErrorResponse(null, JsonRPCErrorCodes.ParseError, "Invalid JSON");
            }

            // 校验认证令牌 - 在触碰命令注册表或执行任何命令之前拒绝
            // Validate the auth token before touching the command registry or executing anything.
            string providedToken = rawRequest["token"]?.Value<string>();
            if (!IsTokenValid(providedToken))
            {
                _logger.Warning("拒绝未授权的请求\nRejected unauthorized request.");
                return CreateErrorResponse(
                    rawRequest["id"]?.ToString(),
                    UnauthorizedErrorCode,
                    "Unauthorized: missing or invalid token"
                );
            }

            JsonRPCRequest request;

            try
            {
                request = rawRequest.ToObject<JsonRPCRequest>();

                // 验证请求格式是否有效
                // Verify that the request format is valid.
                if (request == null || !request.IsValid())
                {
                    return CreateErrorResponse(
                        null,
                        JsonRPCErrorCodes.InvalidRequest,
                        "Invalid JSON-RPC request"
                    );
                }

                // 查找命令
                // Search for the command in the registry.
                if (!_commandRegistry.TryGetCommand(request.Method, out var command))
                {
                    return CreateErrorResponse(request.Id, JsonRPCErrorCodes.MethodNotFound,
                        $"Method '{request.Method}' not found");
                }

                // 执行命令
                // Execute command.
                try
                {                
                    object result = command.Execute(request.GetParamsObject(), request.Id);

                    return CreateSuccessResponse(request.Id, result);
                }
                catch (Exception ex)
                {
                    return CreateErrorResponse(request.Id, JsonRPCErrorCodes.InternalError, ex.Message);
                }
            }
            catch (JsonException)
            {
                // JSON解析错误
                // JSON parsing error.
                return CreateErrorResponse(
                    null,
                    JsonRPCErrorCodes.ParseError,
                    "Invalid JSON"
                );
            }
            catch (Exception ex)
            {
                // 处理请求时的其他错误
                // Catch other errors produced when processing requests.
                return CreateErrorResponse(
                    null,
                    JsonRPCErrorCodes.InternalError,
                    $"Internal error: {ex.Message}"
                );
            }
        }

        private string CreateSuccessResponse(string id, object result)
        {
            var response = new JsonRPCSuccessResponse
            {
                Id = id,
                Result = result is JToken jToken ? jToken : JToken.FromObject(result)
            };

            return response.ToJson();
        }

        private string CreateErrorResponse(string id, int code, string message, object data = null)
        {
            var response = new JsonRPCErrorResponse
            {
                Id = id,
                Error = new JsonRPCError
                {
                    Code = code,
                    Message = message,
                    Data = data != null ? JToken.FromObject(data) : null
                }
            };

            return response.ToJson();
        }
    }
}
