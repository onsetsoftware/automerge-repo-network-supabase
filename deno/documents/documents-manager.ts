import { Automerge, type Doc, type Payload } from "../deps.ts";
import { Executor, transact } from "../db/pg.ts";

export type PeerId = string & { __peerId: false }
export type ChannelId = string & { __channelId: false }

export interface DecodedMessage {
  type: string
  senderId: PeerId
  targetId: PeerId
  channelId: ChannelId
  data: Uint8Array
  broadcast: boolean
}

function shouldLogError(e: Error) {
  return !e.toString().includes("could not serialize access due to concurrent update") &&
      !e.toString().includes("violates row-level security policy");
}

export class DocumentsManager {
  syncStates: {[peerId: PeerId] : { [documentId: ChannelId] : Automerge.SyncState}} = {};
  
  resetDocState(senderId: PeerId, channelId: ChannelId) {
    this.syncStates[senderId] = this.syncStates[senderId] || {};
    
    this.syncStates[senderId][channelId] = this.syncStates[senderId][channelId] ? Automerge.decodeSyncState(Automerge.encodeSyncState(this.syncStates[senderId][channelId])) : Automerge.initSyncState();
  }
  
  setupPeer(peerId: PeerId) {
    console.log("Setting up peer", peerId);
    this.syncStates[peerId] = {};
  }
  
  async updateDoc({ senderId, channelId, data }: DecodedMessage, auth: Payload) {
    this.syncStates[senderId] = this.syncStates[senderId] || {};
    
    let doc: Doc<any> = {};
    
    try {
      return await transact(async (executor) => {
        if (this.syncStates[senderId] === undefined) {
          this.syncStates[senderId] = {};
        }
        doc = await DocumentsManager.getDoc(executor, channelId);
        
        const syncState = this.syncStates[senderId]?.[channelId] || Automerge.initSyncState();
  
        let newDoc, newSyncState;
  
        try {
          [newDoc, newSyncState] = Automerge.receiveSyncMessage(doc, syncState, data);
        } catch (e) {
          console.log("Automerge sync state error caught", e);
          [newDoc, newSyncState] = Automerge.receiveSyncMessage(doc, Automerge.decodeSyncState(Automerge.encodeSyncState(syncState)), data);
        }
  
        const equalArrays = (a: unknown[], b: unknown[]) =>
            a.length === b.length && a.every((element, index) => element === b[index])
        
        try  {
          await this.saveDoc(executor, channelId, newDoc, senderId, !equalArrays(Automerge.getHeads(newDoc), Automerge.getHeads(doc)));
        } catch (e) {
          if (shouldLogError(e)) {
            console.warn('Failed to save document:', e);
          }
          
          this.resetDocState(senderId, channelId);
          throw e;
        }
        
        this.syncStates[senderId][channelId] = newSyncState;
        
        return await this.generateSyncMessage(channelId, senderId, auth, newDoc);
        
        
      }, auth);
      
      
    } catch (e) {
      if (shouldLogError(e)) {
        console.log("Automerge error caught:", e);
      }
      throw e;
    }
  }

  async generateSyncMessage(channelId: ChannelId, senderId: PeerId, auth: Payload, doc?: Automerge.Doc<any>) {
    this.syncStates[senderId] = this.syncStates[senderId] || {};
    
    doc = doc || await transact((executor => DocumentsManager.getDoc(executor!, channelId)), auth);
    const syncState = this.syncStates[senderId]?.[channelId] || Automerge.initSyncState();
    
    const [newSyncState, message] = Automerge.generateSyncMessage(doc, syncState);

    this.syncStates[senderId][channelId] = newSyncState;
    
    return message;
  }
  
  async saveDoc(executor: Executor, channelId: ChannelId, doc: Automerge.Doc<any>, peerId: PeerId, changed: boolean) {
      const data = Automerge.save(doc);
      
      try {
       Automerge.load(data);   
      } catch (e) {
        console.log("Failed to update document");
        this.resetDocState(peerId, channelId);
        throw e;
      }
    
    
      return await executor("insert into documents (id, data, updated_by_peer, changed) values ($1, $2, $3, $4) on conflict (id) do update set data = excluded.data, updated_by_peer = excluded.updated_by_peer, changed = excluded.changed", [channelId, Automerge.save(doc), peerId, changed]);
  }

  static async getDoc(executor: Executor, channelId: ChannelId) {
    try {
      const data = await executor<{data: Uint8Array}>("select data from documents where id = $1 limit 1", [channelId]);
      
      return data?.rows[0]?.data ? Automerge.load(data.rows[0].data) : Automerge.init();
    } catch (e) {
      throw e;
    }
  }
}

export const documentsManager = new DocumentsManager();
