import { defineModule } from "../platform-module.js";
import { registerPlatformModulesRoutes } from "./routes.js";

export const platformModulesModule = defineModule({
  id: "platform-modules",
  domain: "platform",
  title: "قائمة الوحدات المركّبة وما تستمع إليه",
  register: registerPlatformModulesRoutes,
});
