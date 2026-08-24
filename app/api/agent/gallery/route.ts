import { handleAgentAsset } from "../../../lib/agent-media-assets";

export function GET(request: Request) {
  return handleAgentAsset(request, "visual");
}

export function POST(request: Request) {
  return handleAgentAsset(request, "visual");
}

export function PATCH(request: Request) {
  return handleAgentAsset(request, "visual");
}

export function DELETE(request: Request) {
  return handleAgentAsset(request, "visual");
}
