import type { PluginClientContext, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { GreetingScreen } from "./client/greeting";
import { BoardScreen } from "./client/board";

function GreetingItem({ currentScreen, openScreen }: PluginSidebarItemProps) {
  return (
    <SidebarRow
      icon="MessageCircle"
      active={currentScreen?.screenId === "greeting"}
      onPress={() => openScreen({ screenId: "greeting" })}
    />
  );
}

function BoardItem({ currentScreen, openScreen }: PluginSidebarItemProps) {
  return (
    <SidebarRow
      icon="ClipboardList"
      active={currentScreen?.screenId === "pp-board"}
      onPress={() => openScreen({ screenId: "pp-board" })}
    />
  );
}

export default function contribute(client: PluginClientContext) {
  client.addScreen({ id: "greeting", title: "Greeting", Component: GreetingScreen });
  client.addScreen({ id: "pp-board", title: "Tasks", Component: BoardScreen });
  client.addSidebarHeaderItem({ id: "greeting", title: "Greeting", Component: GreetingItem });
  client.addSidebarHeaderItem({ id: "pp-board", title: "Tasks", Component: BoardItem });
  return () => {};
}
