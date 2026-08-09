const {
  isContextTokenFailure,
} = require("./outbound-delivery-errors");

class OutboundDeliveryCoordinator {
  constructor({ store, tokenRegistry, channelAdapter }) {
    if (!store || !tokenRegistry || !channelAdapter) {
      throw new Error("delivery coordinator dependencies are required");
    }
    this.store = store;
    this.tokenRegistry = tokenRegistry;
    this.channelAdapter = channelAdapter;
    this.activeByRecipient = new Map();
  }

  flushNext(accountId, userId) {
    const key = buildRecipientKey(accountId, userId);
    const previous = this.activeByRecipient.get(key)
      || Promise.resolve();
    const current = previous
      .catch(() => {})
      .then(() => this.deliverNext(accountId, userId));

    this.activeByRecipient.set(key, current);
    return current.finally(() => {
      if (this.activeByRecipient.get(key) === current) {
        this.activeByRecipient.delete(key);
      }
    });
  }


  async deliverNext(accountId, userId) {
    const tokenState = this.tokenRegistry.getCurrent(accountId, userId);
    if (!tokenState || tokenState.invalid) {
      return { status: "waiting_for_token" };
    }

    const delivery = this.store.claimNext(accountId, userId, {
      tokenVersion: tokenState.version,
    });
    if (!delivery) {
      return { status: "idle" };
    }

    try {
      if (delivery.kind === "image" || delivery.kind === "file") {
        await this.channelAdapter.sendFile({
          userId: delivery.userId,
          filePath: delivery.filePath,
          contextToken: tokenState.token,
        });
      } else {
        await this.channelAdapter.sendText({
          userId: delivery.userId,
          text: delivery.text,
          contextToken: tokenState.token,
        });
      }
    } catch (error) {
      if (!isContextTokenFailure(error)) {
        const failed = this.store.markFailed(delivery.deliveryId, {
          lastError: "send_failed",
        });
        return {
          deliveryId: failed.deliveryId,
          status: failed.status,
        };
      }

      this.tokenRegistry.invalidate({
        accountId: delivery.accountId,
        userId: delivery.userId,
        tokenVersion: tokenState.version,
      });
      const deferred = this.store.markDeferred(delivery.deliveryId, {
        lastError: "context_token_invalid",
      });
      return {
        deliveryId: deferred.deliveryId,
        status: deferred.status,
      };
    }

    const sent = this.store.markSent(delivery.deliveryId);
    return {
      deliveryId: sent.deliveryId,
      status: sent.status,
    };
  }
}

function buildRecipientKey(accountId, userId) {
  return `${String(accountId || "").trim()}::${String(userId || "").trim()}`;
}

module.exports = { OutboundDeliveryCoordinator };
