import EventEmitter from "eventemitter3";
import * as CBOR from "cbor-x";

import type {
  ChannelId,
  DecodedMessage,
  NetworkAdapter,
  NetworkAdapterEvents,
  PeerId,
} from "automerge-repo";
import type { RealtimeChannel, SupabaseClient } from "@supabase/supabase-js";

interface SupabaseNetworkAdapterInterface extends NetworkAdapter {}

export class SupabaseNetworkAdapter
  extends EventEmitter<NetworkAdapterEvents>
  implements SupabaseNetworkAdapterInterface
{
  lastMessages: Record<ChannelId, Buffer[]> = {};

  peerId!: PeerId;
  private channel!: RealtimeChannel;

  private connected = false;
  private channelId!: ChannelId;
  private reconnect: NodeJS.Timeout | null = null;

  private messageQueue: Array<DecodedMessage> = [];
  private syncing: boolean = false;

  constructor(
    protected supabase: SupabaseClient,
    protected functionName: string
  ) {
    super();
  }

  connect(peerId: PeerId) {
    this.peerId = peerId;
    let firstRun = true;

    this.channel = this.supabase
      .channel("document-updates")
      .on<{ changed: boolean }>(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "documents",
          filter: "updated_by_peer=neq." + peerId,
        },
        async (payload) => {
          if (
            // @ts-ignore
            payload.new.changed &&
            !this.shouldQueue() &&
            this.messageQueue.length === 0
          ) {
            this.syncing = true;
            const { data } = await this.makeRequest("pull", {
              senderId: this.peerId,
              channelId: (payload.new as { id: string }).id,
              targetId: "server",
            });

            this.syncing = false;

            if (data) {
              this.receiveMessage(new Uint8Array(data));
            }
          }
        }
      )
      .subscribe((message) => {
        if (message === "SUBSCRIBED") {
          this.connected = true;
          if (this.channelId && !firstRun) {
            this.join(this.channelId);
          }
          firstRun = false;
        } else {
          this.emit("peer-disconnected", { peerId: "server" as PeerId });
          this.connected = false;
        }
      });
  }

  private shouldQueue() {
    return this.syncing;
  }

  queueMessage(message: DecodedMessage) {
    this.messageQueue.push(message);
  }

  sendFromQueue() {
    if (this.messageQueue.length > 0) {
      const message = this.messageQueue.shift()!;
      this.sendMessage(
        message.targetId,
        message.channelId,
        message.data,
        message.broadcast
      );
    }
  }

  async join(channelId: ChannelId) {
    this.channelId = channelId;
    await this.initiateConnection(this.peerId, channelId);
  }

  leave() {
    this.channel.unsubscribe();
  }

  async sendMessage(
    targetId: PeerId,
    channelId: ChannelId,
    message: Uint8Array,
    broadcast: boolean
  ) {
    if (!this.connected) {
      return;
    }

    if (message.byteLength === 0) {
      throw new Error("tried to send a zero-length message");
    }
    if (!this.peerId) {
      throw new Error("Why don't we have a PeerID?");
    }

    const decoded: DecodedMessage = {
      senderId: this.peerId,
      targetId,
      channelId,
      type: "message",
      data: message,
      broadcast,
    };

    if (this.shouldQueue()) {
      this.queueMessage(decoded);
      return;
    }

    const encoded = CBOR.encode(decoded);

    if (
      this.lastMessages[channelId] === undefined ||
      // @ts-ignore
      !(this.lastMessages[channelId].at(-1) == "" + encoded)
    ) {
      this.lastMessages[channelId] = this.lastMessages[channelId] || [];

      if (this.lastMessages[channelId].unshift(encoded) > 10) {
        {
          await this.join(this.channelId);
          this.lastMessages[channelId] = [];
          return;
        }
      } else {
        this.lastMessages[channelId] = [];
      }
      this.syncing = true;

      // This incantation deals with websocket sending the whole
      // underlying buffer even if we just have a uint8array view on it
      const arrayBuf = encoded.buffer.slice(
        encoded.byteOffset,
        encoded.byteOffset + encoded.byteLength
      );

      const { data } = await this.makeRequest("sync-message", arrayBuf);

      this.syncing = false;

      if (data) {
        this.receiveMessage(new Uint8Array(data));
      }

      this.sendFromQueue();
    }
  }

  async initiateConnection(senderId: PeerId, channelId: ChannelId) {
    this.messageQueue = [];

    const { data } = await this.makeRequest("connect", {
      senderId,
      channelId,
    });

    this.connected = true;

    if (data) {
      this.announceConnection(channelId, "server" as PeerId);
    }
  }

  announceConnection(channelId: ChannelId, peerId: PeerId) {
    // return a peer object
    const myPeerId = this.peerId;
    if (!myPeerId) {
      throw new Error("we should have a peer ID by now");
    }

    this.emit("peer-candidate", { peerId, channelId });
  }

  receiveMessage(message: Uint8Array) {
    const decoded = CBOR.decode(message) as DecodedMessage;
    const { senderId, targetId, channelId, data, broadcast } = decoded;

    if (data.byteLength === 0) {
      return;
    }

    this.emit("message", {
      channelId,
      senderId,
      targetId,
      message: new Uint8Array(data),
      broadcast,
    });
  }

  private resetConnection() {
    if (!this.reconnect) {
      this.emit("peer-disconnected", { peerId: "server" as PeerId });

      this.reconnect = setTimeout(() => {
        this.reconnect = null;
        this.join(this.channelId);
      }, 3000);
    }
  }

  private makeRequest = async <T extends "sync-message" | "pull" | "connect">(
    url: T,
    body: T extends "sync-message"
      ? ArrayBuffer
      : {
          senderId: PeerId;
          channelId: string;
          targetId?: string;
        }
  ): Promise<{ data: any }> => {
    try {
      // @ts-ignore
      const isPlatform = this.supabase.supabaseUrl.match(
        /(supabase\.co)|(supabase\.in)/
      );

      const { data, error } = await this.supabase.functions.invoke(
        (isPlatform ? `${this.functionName}/` : "") + url,
        {
          headers: {
            Accept:
              url === "connect"
                ? "application/json"
                : "application/octet-stream",
            "content-type":
              url === "sync-message"
                ? "application/octet-stream"
                : "application/json",
          },
          body: body,
        }
      );

      if (error) {
        console.log(error);
        this.resetConnection();

        return { data: null };
      }

      return { data: data instanceof Blob ? await data.arrayBuffer() : data };
    } catch (e) {
      this.resetConnection();

      return { data: null };
    }
  };
}
