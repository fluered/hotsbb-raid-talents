import React from 'react';

export default function NewFeature({ telemetry, layout }: { telemetry: any; layout: any[] }) {
  // telemetry is the object you just pasted
  const activeNodes = telemetry?.talentTree || [];

  return (
    <div className="grid gap-1">
      {layout.map((node: any) => {
        // Find if the player has this node active
        const activeNode = activeNodes.find((t: any) => t.nodeID === node.nodeID);
        
        return (
          <div 
            key={node.nodeID} 
            className={`w-6 h-6 ${activeNode ? 'bg-amber-500' : 'bg-zinc-800'}`}
            style={{ gridRow: node.row, gridColumn: node.column }}
          />
        );
      })}
    </div>
  );
}