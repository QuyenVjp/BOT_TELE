import type { FulfillmentType } from "./fulfillment-type.js";

export interface DescriptionTemplate {
  description: string;
  whatCustomerReceives: string;
  usageInstructions: string;
  warranty: string;
}

export const DESCRIPTION_TEMPLATES: Record<FulfillmentType, DescriptionTemplate> = {
  STOCK_ACCOUNT: {
    description: "Tài khoản chính hãng, thông tin đăng nhập được giao tự động.",
    whatCustomerReceives: "Tên đăng nhập và mật khẩu.",
    usageInstructions: "Đăng nhập theo hướng dẫn sau khi nhận hàng.",
    warranty: "Bảo hành trong thời gian sử dụng theo chính sách cửa hàng.",
  },
  STOCK_CODE: {
    description: "Mã kích hoạt điện tử giao ngay sau khi thanh toán.",
    whatCustomerReceives: "Một mã kích hoạt hợp lệ.",
    usageInstructions: "Nhập mã vào trang hoặc ứng dụng tương ứng.",
    warranty: "Hỗ trợ kiểm tra mã trong thời gian bảo hành.",
  },
  DIGITAL_FILE: {
    description: "Tệp số chất lượng cao, tải xuống sau khi thanh toán.",
    whatCustomerReceives: "Liên kết tải tệp và hướng dẫn sử dụng.",
    usageInstructions: "Tải tệp về thiết bị và làm theo hướng dẫn đi kèm.",
    warranty: "Hỗ trợ tải lại tệp trong thời gian bảo hành.",
  },
  QUANTITY_STOCK: {
    description: "Sản phẩm số lượng giới hạn, xử lý nhanh chóng.",
    whatCustomerReceives: "Số lượng sản phẩm đã đặt.",
    usageInstructions: "Sử dụng theo hướng dẫn được cung cấp.",
    warranty: "Hỗ trợ theo chính sách cửa hàng.",
  },
  UNLIMITED_SERVICE: {
    description: "Dịch vụ số không giới hạn.",
    whatCustomerReceives: "Quyền sử dụng dịch vụ đã mua.",
    usageInstructions: "Liên hệ hỗ trợ nếu cần hướng dẫn.",
    warranty: "Hỗ trợ trong thời gian cung cấp dịch vụ.",
  },
  MANUAL_FULFILLMENT: {
    description: "Sản phẩm được xử lý thủ công bởi đội ngũ cửa hàng.",
    whatCustomerReceives: "Kết quả xử lý theo yêu cầu đơn hàng.",
    usageInstructions: "Cung cấp thông tin cần thiết sau khi đặt hàng.",
    warranty: "Hỗ trợ theo chính sách cửa hàng.",
  },
  SUPPLIER_API: {
    description: "Sản phẩm được giao qua nhà cung cấp liên kết.",
    whatCustomerReceives: "Quyền truy cập hoặc mã từ nhà cung cấp.",
    usageInstructions: "Làm theo hướng dẫn giao kèm sản phẩm.",
    warranty: "Hỗ trợ phối hợp với nhà cung cấp.",
  },
};

export function getDescriptionTemplate(type: FulfillmentType): DescriptionTemplate {
  return DESCRIPTION_TEMPLATES[type];
}
