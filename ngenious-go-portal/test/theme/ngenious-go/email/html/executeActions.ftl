<#import "template.ftl" as layout>
<@layout.emailLayout>
  <p style="margin:0 0 10px;color:#087f78;font-size:14px;font-weight:700;letter-spacing:1.4px;text-transform:uppercase;">Welcome</p>
  <h1 style="margin:0 0 22px;color:#102239;font-size:30px;line-height:38px;">Create your ngenious password</h1>
  <p style="margin:0 0 16px;color:#31465a;font-size:16px;line-height:25px;">Hello ${kcSanitize((user.firstName)!"there")?no_esc},</p>
  <p style="margin:0 0 26px;color:#31465a;font-size:16px;line-height:25px;">Your ngenious account is ready. Use the secure link below to create your password and finish signing in.</p>
  <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:0 0 26px;">
    <tr>
      <td style="border-radius:10px;background:#22bec7;">
        <a href="${kcSanitize(link)?no_esc}" style="display:inline-block;padding:15px 24px;color:#102239;font-size:16px;font-weight:700;text-decoration:none;">Create my password</a>
      </td>
    </tr>
  </table>
  <p style="margin:0 0 10px;color:#64778a;font-size:13px;line-height:20px;">This link expires in ${linkExpirationFormatter(linkExpiration)} and can be used only for this account setup.</p>
  <p style="margin:0;color:#64778a;font-size:13px;line-height:20px;">If you were not expecting this message, you can safely ignore it.</p>
</@layout.emailLayout>

