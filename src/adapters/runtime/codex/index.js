const { CodexRpcClient } = require("./rpc-client");
const { buildOpeningTurnText, buildInstructionRefreshText } = require("../shared-instructions");
const { mapCodexMessageToRuntimeEvent } = require("./events");
const {
  extractAssistantText,
  extractFailureText,
  extractThreadId,
  extractTurnId,
  extractThreadIdFromParams,
  extractTurnIdFromParams,
  isAssistantItemCompleted,
} = require("./message-utils");
const { resolveEffectiveModelForEffort } = require("./model-catalog");
const { SessionStore } = require("./session-store");
const { resolveCodexProjectToolMcpServerConfig } = require("./mcp-config");

function createCodexRuntimeAdapter(config) {
  const sessionStore = new SessionStore({ filePath: config.sessionsFile, runtimeId: "codex" });
  let client = null;
  let readyState = null;
  const configuredModel = normalizeText(config.codexModel);
  const configuredModelProvider = normalizeText(config.codexModelProvider);

  function resolveModel(model = "", storedParams = null) {
    if (configuredModel) {
      return configuredModel;
    }
    if (storedParams && normalizeText(storedParams.modelProvider) !== configuredModelProvider) {
      return "";
    }
    return normalizeText(model);
  }

  function ensureClient() {
    if (!client) {
      client = new CodexRpcClient({
        endpoint: config.codexEndpoint,
        codexCommand: config.codexCommand,
        env: process.env,
        extraWritableRoots: [config.stateDir],
        mcpServerConfig: resolveCodexProjectToolMcpServerConfig(),
      });
    }
    return client;
  }

  return {
    describe() {
      return {
        id: "codex",
        kind: "runtime",
        endpoint: config.codexEndpoint || "(spawn)",
        sessionsFile: config.sessionsFile,
        model: configuredModel,
        modelProvider: configuredModelProvider,
      };
    },
    createClient() {
      return ensureClient();
    },
    onEvent(listener) {
      if (typeof listener !== "function") {
        return () => {};
      }
      const runtimeClient = ensureClient();
      return runtimeClient.onMessage((message) => {
        const event = mapCodexMessageToRuntimeEvent(message);
        if (event) {
          listener(event, message);
        }
      });
    },
    getSessionStore() {
      return sessionStore;
    },
    getTurnCapabilities({ model = "" } = {}) {
      const forcedNativeImageInput = config.codexNativeImageInput;
      if (typeof forcedNativeImageInput === "boolean") {
        return {
          nativeImageInput: forcedNativeImageInput,
          toolImageRead: false,
        };
      }
      const effectiveModel = normalizeText(configuredModel) || normalizeText(model);
      const catalog = sessionStore.getAvailableModelCatalog();
      const catalogModel = resolveEffectiveModelForEffort(catalog?.models, effectiveModel);
      return {
        nativeImageInput: hasImageInputModality(catalogModel),
        toolImageRead: false,
      };
    },
    async initialize() {
      const runtimeClient = ensureClient();
      if (readyState && runtimeClient.isReady && runtimeClient.isTransportReady()) {
        return readyState;
      }
      await runtimeClient.connect();
      await runtimeClient.initialize();
      const modelResponse = await runtimeClient.listModels().catch(() => null);
      const models = Array.isArray(modelResponse?.result?.data)
        ? modelResponse.result.data
        : [];
      if (models.length) {
        sessionStore.setAvailableModelCatalog(models);
      }
      readyState = {
        endpoint: config.codexEndpoint || "(spawn)",
        models,
      };
      return readyState;
    },
    async close() {
      if (client) {
        await client.close();
      }
      readyState = null;
      client = null;
    },
    async startFreshThreadDraft() {
      return {};
    },
    async respondApproval({ requestId, decision, result = null }) {
      const runtimeClient = ensureClient();
      await this.initialize();
      if (requestId == null || String(requestId).trim() === "") {
        throw new Error("approval response requires a requestId");
      }
      const responsePayload = result && typeof result === "object"
        ? result
        : { decision: decision === "accept" ? "accept" : "decline" };
      await runtimeClient.sendResponse(requestId, responsePayload);
      return {
        requestId,
        ...(result && typeof result === "object"
          ? { result: responsePayload }
          : { decision: responsePayload.decision }),
      };
    },
    async cancelTurn({ threadId, turnId }) {
      const runtimeClient = ensureClient();
      await this.initialize();
      await runtimeClient.cancelTurn({ threadId, turnId });
      return { threadId, turnId };
    },
    async resumeThread({ threadId }) {
      const runtimeClient = ensureClient();
      await this.initialize();
      return runtimeClient.resumeThread({
        threadId,
        model: configuredModel,
        modelProvider: configuredModelProvider,
      });
    },
    async compactThread({ threadId }) {
      const runtimeClient = ensureClient();
      await this.initialize();
      return runtimeClient.compactThread({ threadId });
    },
    async refreshThreadInstructions({ threadId, workspaceRoot, model = "", modelProvider = "" }) {
      const runtimeClient = ensureClient();
      await this.initialize();
      const refreshText = buildInstructionRefreshText(config);
      const desiredModel = resolveModel(model, { modelProvider });
      await runtimeClient.resumeThread({
        threadId,
        model: desiredModel,
        modelProvider: configuredModelProvider,
      });
      const completion = waitForTurnCompletion(runtimeClient, threadId);
      await runtimeClient.sendUserMessage({
        threadId,
        text: refreshText,
        model: desiredModel,
        modelProvider: configuredModelProvider,
        workspaceRoot,
      });
      const result = await completion;
      return { threadId, ...result };
    },
    async sendTextTurn(args) {
      return this.sendTurn(args);
    },
    async sendTurn({ bindingKey, workspaceRoot, text, attachments = [], metadata = {}, model = "" }) {
      const runtimeClient = ensureClient();
      await this.initialize();

      let threadId = sessionStore.getThreadIdForWorkspace(bindingKey, workspaceRoot);
      let volumeNotice = "";
      if (threadId) {
        let volume = sessionStore.getThreadVolumeState(bindingKey, workspaceRoot);
        if (!volume.startedAt) {
          sessionStore.setThreadVolumeState(bindingKey, workspaceRoot, {
            startedAt: new Date().toISOString(),
            reminderSentAt: "",
          });
          volume = sessionStore.getThreadVolumeState(bindingKey, workspaceRoot);
        }
        const ageDays = threadAgeDays(volume.startedAt);
        const volumeDays = normalizeVolumeDays(config.threadVolumeDays);
        if (ageDays >= volumeDays) {
          sessionStore.clearThreadIdForWorkspace(bindingKey, workspaceRoot);
          threadId = "";
          volumeNotice = "A fresh conversation volume has started because the previous one reached seven days. Recent memory has been reloaded. Briefly tell the user naturally.";
        } else if (ageDays >= volumeDays - 1 && !volume.reminderSentAt) {
          volumeNotice = "This conversation volume is nearly seven days old. Briefly remind the user that you will start a fresh volume at the next natural boundary.";
          sessionStore.setThreadVolumeState(bindingKey, workspaceRoot, {
            ...volume,
            reminderSentAt: new Date().toISOString(),
          });
        }
      }
      const storedParams = sessionStore.getRuntimeParamsForWorkspace(bindingKey, workspaceRoot);
      const desiredModel = resolveModel(model, storedParams);
      const desiredModelProvider = configuredModelProvider;
      if (threadId && !runtimeParamsMatch(storedParams, {
        model: desiredModel,
        modelProvider: desiredModelProvider,
      })) {
        sessionStore.clearThreadIdForWorkspace(bindingKey, workspaceRoot);
        threadId = "";
      }
      sessionStore.setRuntimeParamsForWorkspace(bindingKey, workspaceRoot, {
        model: desiredModel,
        modelProvider: desiredModelProvider,
      });
      let outboundText = text;
      if (!threadId) {
        const response = await runtimeClient.startThread({
          cwd: workspaceRoot,
          model: desiredModel,
          modelProvider: desiredModelProvider,
        });
        threadId = extractThreadId(response);
        if (!threadId) {
          throw new Error("thread/start did not return a thread id");
        }
        sessionStore.setThreadIdForWorkspace(bindingKey, workspaceRoot, threadId, metadata);
        outboundText = buildOpeningTurnText(config, appendVolumeNotice(text, volumeNotice));
      } else {
        await runtimeClient.resumeThread({
          threadId,
          model: desiredModel,
          modelProvider: desiredModelProvider,
        }).catch(async () => {
          sessionStore.clearThreadIdForWorkspace(bindingKey, workspaceRoot);
          const recreated = await runtimeClient.startThread({
            cwd: workspaceRoot,
            model: desiredModel,
            modelProvider: desiredModelProvider,
          });
          threadId = extractThreadId(recreated);
          if (!threadId) {
            throw new Error("thread/start did not return a thread id");
          }
          sessionStore.setThreadIdForWorkspace(bindingKey, workspaceRoot, threadId, metadata);
          sessionStore.setRuntimeParamsForWorkspace(bindingKey, workspaceRoot, {
            model: desiredModel,
            modelProvider: desiredModelProvider,
          });
          outboundText = buildOpeningTurnText(config, appendVolumeNotice(text, volumeNotice));
        });
      }
      if (threadId && volumeNotice && outboundText === text) {
        outboundText = appendVolumeNotice(text, volumeNotice);
      }

      const response = await runtimeClient.sendUserMessage({
        threadId,
        text: outboundText,
        attachments,
        model: desiredModel,
        modelProvider: desiredModelProvider,
        workspaceRoot,
      });
      return {
        threadId,
        turnId: extractTurnId(response),
      };
    },
  };
}

module.exports = { createCodexRuntimeAdapter };

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function runtimeParamsMatch(storedParams, desiredParams) {
  return normalizeText(storedParams?.model) === normalizeText(desiredParams?.model)
    && normalizeText(storedParams?.modelProvider) === normalizeText(desiredParams?.modelProvider);
}

function normalizeVolumeDays(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 2 ? Math.min(parsed, 30) : 7;
}

function threadAgeDays(startedAt, now = Date.now()) {
  const started = Date.parse(startedAt);
  return Number.isFinite(started) ? (now - started) / 86400000 : 0;
}

function appendVolumeNotice(text, notice) {
  if (!notice) return text;
  return `${String(text || "").trim()}\n\nSYSTEM CONTINUITY NOTE: ${notice}`.trim();
}

function hasImageInputModality(model) {
  const modalities = Array.isArray(model?.inputModalities) ? model.inputModalities : [];
  return modalities.some((item) => normalizeText(item).toLowerCase() === "image");
}

function waitForTurnCompletion(client, threadId) {
  return new Promise((resolve, reject) => {
    let activeTurnId = "";
    const itemOrder = [];
    const completedTextByItemId = new Map();

    const cleanup = () => {
      unsubscribe();
      clearTimeout(timer);
    };

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("codex turn timed out"));
    }, 10 * 60_000);

    const unsubscribe = client.onMessage((message) => {
      const params = message?.params || {};
      if (extractThreadIdFromParams(params) !== threadId) {
        return;
      }

      if ((message?.method === "turn/started" || message?.method === "turn/start") && !activeTurnId) {
        activeTurnId = extractTurnIdFromParams(params);
        return;
      }

      if (isAssistantItemCompleted(message)) {
        const itemId = typeof params?.item?.id === "string" ? params.item.id.trim() : `item-${itemOrder.length + 1}`;
        if (!completedTextByItemId.has(itemId)) {
          itemOrder.push(itemId);
        }
        completedTextByItemId.set(itemId, extractAssistantText(params));
        return;
      }

      if (message?.method === "turn/failed") {
        cleanup();
        reject(new Error(extractFailureText(params)));
        return;
      }

      if (message?.method === "turn/completed") {
        const completedTurnId = extractTurnIdFromParams(params);
        if (activeTurnId && completedTurnId && completedTurnId !== activeTurnId) {
          return;
        }
        cleanup();
        const text = itemOrder
          .map((itemId) => completedTextByItemId.get(itemId) || "")
          .filter(Boolean)
          .join("\n\n")
          .trim();
        resolve({
          turnId: completedTurnId || activeTurnId,
          text: text || "Completed.",
        });
      }
    });
  });
}
