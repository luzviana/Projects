<#import "template.ftl" as layout>
<@layout.emailLayout>
  <p style="margin:0 0 10px;color:#087f78;font-size:14px;font-weight:700;letter-spacing:1.4px;text-transform:uppercase;">Account security</p>
  <h1 style="margin:0 0 22px;color:#102239;font-size:30px;line-height:38px;">Reset your ngenious password</h1>
  <p style="margin:0 0 16px;color:#31465a;font-size:16px;line-height:25px;">Hello ${kcSanitize((user.firstName)!"there")?no_esc},</p>
  <p style="margin:0 0 26px;color:#31465a;font-size:16px;line-height:25px;">We received a request to reset your ngenious password.</p>
  <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:0 0 26px;">
    <tr>
      <td style="border-radius:10px;background:#22bec7;">
        <a href="${kcSanitize(link)?no_esc}" style="display:inline-block;padding:15px 24px;color:#102239;font-size:16px;font-weight:700;text-decoration:none;">Reset my password</a>
      </td>
    </tr>
  </table>
  <p style="margin:0 0 10px;color:#64778a;font-size:13px;line-height:20px;">This link expires in ${linkExpirationFormatter(linkExpiration)}.</p>
  <p style="margin:0;color:#64778a;font-size:13px;line-height:20px;">If you did not request a password reset, ignore this message. Your password will not change.</p>
</@layout.emailLayout>

