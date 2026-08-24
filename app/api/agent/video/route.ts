import { handleAgentAsset } from "../../../lib/agent-media-assets";

export function GET(request: Request) {
  return handleAgentAsset(request, "video");
}

export function POST(request: Request) {
  return handleAgentAsset(request, "video");
}

export function PATCH(request: Request) {
  return handleAgentAsset(request, "video");
}

export function DELETE(request: Request) {
  return handleAgentAsset(request, "video");
}
