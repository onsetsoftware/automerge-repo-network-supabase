import { decode, cborEncode, cborDecode } from "./deps.ts";
import { type ChannelId, type DecodedMessage, documentsManager, type PeerId } from "./documents/documents-manager.ts";
import { getPool } from "./db/pg.ts";

export const defaultCorsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type",
};

export async function handleRequest(req: Request, corsHeaders: Record<string, string> = defaultCorsHeaders) {
  getPool();
  
  const { searchParams: query, pathname: action } = new URL(req.url);

  const authorization = req.headers.get("authorization")?.split(" ")[1]!;
  const { payload: auth } = decode(authorization);

  try {
    switch (action.split("/").at(-1)) {
      case "connect": {
        const json: {senderId: string} = await req.json();
        documentsManager.setupPeer(json.senderId as PeerId);

        console.log("peer " + json.senderId + " connected");
        return new Response(JSON.stringify({status: 'connected'}), {
          headers: {"Content-Type": "application/json", ...corsHeaders},
          status: 200,
        });
      }
      case "pull": {
        const {targetId, channelId, senderId}: {targetId: PeerId, channelId: ChannelId, senderId: PeerId} = await req.json();

        const syncMessage = await documentsManager.generateSyncMessage(channelId, senderId, auth);

        const response: DecodedMessage = {
          broadcast: false,
          channelId: channelId,
          data: syncMessage || new Uint8Array([]),
          targetId: senderId,
          senderId: targetId,
          type: ""
        }

        return new Response(cborEncode(response), {
          headers: {"Content-Type": "application/octet-stream", ...corsHeaders},
          status: 200,
        });
      }
      case "sync-message": {
        const message: DecodedMessage = cborDecode(new Uint8Array(await req.arrayBuffer()));
        try {

          const syncMessage = await documentsManager.updateDoc(message, auth);

          const response: DecodedMessage = {
            broadcast: false,
            channelId: message.channelId,
            data: syncMessage || new Uint8Array([]),
            targetId: message.senderId,
            senderId: message.targetId,
            type: ""
          }

          return new Response(cborEncode(response), {
            headers: {"Content-Type": "application/octet-stream", ...corsHeaders},
            status: 200,
          });
        } catch (e) {
          documentsManager.resetDocState(message.senderId, message.channelId);

          throw e;
        }
      }
      default: {
        return new Response("Invalid Action - " + String(action), {
          headers: corsHeaders,
          status: 404,
        });
      }
    }
  } catch (e) {
    if (e.toString().includes("violates row-level security policy")) {
        if (auth.role === "anon") {
          return new Response("Unauthorized - RLS Error", {
            headers: corsHeaders,
            status: 401,
          });
        }
        
        return new Response("Forbidden - RLS Error", {
          headers: corsHeaders,
          status: 403,
        });
      
    }
    
    
    if (e.toString().includes("Broken pipe")) {
      return new Response("Connection Error - Please try again", {
        headers: corsHeaders,
        status: 400,
      });
    }
    return new Response(e.toString(), {
      headers: { ...corsHeaders },
      status: 500,
    });
  }
}
