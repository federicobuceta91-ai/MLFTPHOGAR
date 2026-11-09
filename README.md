# ML con More

Aplicación interna para gestionar la tienda de MercadoLibre: rentabilidad, stock,
publicaciones activas/inactivas, preguntas y reputación.

## Variables de entorno

Configurar en Render (Dashboard del servicio → Environment), no en este repo:

- `ML_APP_ID`, `ML_CLIENT_SECRET`, `ML_REDIRECT_URI`: credenciales de la app de
  MercadoLibre Developers.
- `DATABASE_URL`: Internal Database URL de la base Postgres de Render.
- `APP_LOGIN_USER`, `APP_LOGIN_PASS`: usuario y clave compartidos para entrar a la app.
- `SESSION_SECRET`: cualquier texto largo al azar, para firmar las sesiones.

Ver `.env.example` para la lista completa.

## Primer uso

1. Desplegar en Render con las variables de entorno cargadas.
2. Entrar a la URL pública, loguearse con `APP_LOGIN_USER` / `APP_LOGIN_PASS`.
3. Conectar la cuenta de MercadoLibre (botón en pantalla).
4. Cargar el costo de cada producto desde la pantalla principal para ver la rentabilidad.
