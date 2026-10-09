import { ModuleProvider, Modules } from "@medusajs/framework/utils";
import PayhereProviderService from "./service";

export default ModuleProvider(Modules.PAYMENT, { services: [PayhereProviderService] });
