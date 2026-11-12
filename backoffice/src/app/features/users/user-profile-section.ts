import { Component, computed, inject } from '@angular/core';
import { FormField } from '@angular/forms/signals';
import { TPipe } from '../../core/i18n/t-pipe';
import { AvatarField } from '../../shared/ui/avatar-field/avatar-field';
import { Checkbox } from '../../shared/ui/checkbox/checkbox';
import { Select } from '../../shared/ui/select/select';
import { TextField } from '../../shared/ui/text-field/text-field';
import { Textarea } from '../../shared/ui/textarea/textarea';
import { UserFormState } from './user-form-state';

/** Personal data of the user: avatar, name, contacts, language, description and statistics flag. */
@Component({
  selector: 'fc-user-profile-section',
  imports: [AvatarField, Checkbox, FormField, Select, TextField, Textarea, TPipe],
  templateUrl: './user-profile-section.html',
  styleUrl: './user-section.css',
})
export class UserProfileSection {
  protected readonly state = inject(UserFormState);
  protected readonly form = this.state.userForm;
  /** A legacy image the backend cannot show: the user has one but the form has none to display. */
  protected readonly hiddenImage = computed(() => {
    const user = this.state.user();
    return user !== null && user.hasAvatar && !user.avatar;
  });
}
