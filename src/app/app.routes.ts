import { Routes } from '@angular/router';

import { LeitorChave } from './leitor/leitor-chave';

export const routes: Routes = [
  { path: '', component: LeitorChave },
  { path: '**', redirectTo: '' }
];
